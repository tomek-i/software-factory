import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, REVIEW_PASS, type FakeStep } from "../../test/helpers.js";
import type { Store } from "../store/store.js";
import { approveTarget, runDirOf, waitingCommit } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver learn stage", () => {
  /** One review lens, and the merge gate as given (default: always, so the run merges by itself). */
  const config = (merge = "always") =>
    `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  merge: ${merge}\nreviews:\n  always: [code]\n  ui: []\n`;
  const CODE_PASS: FakeStep = { role: "reviewer-code", output: REVIEW_PASS };
  const LESSON = {
    observation: "The builder wrote `broken` first and the feature check failed.",
    evidence: "round-1/checks.md (feature failed), round-2/checks.md (passed)",
    rule: "Run `node check.js` before handing over; the gate only passes when feature.txt says fixed.",
  };
  const learned = (lessons: object[]) =>
    `LESSONS: ${lessons.length}\n\n## Summary\n- the gate failed once\n\n## Lessons\n\`\`\`json\n${JSON.stringify(lessons, null, 2)}\n\`\`\`\n`;
  /** A run whose first build fails the quality gate, so it takes two rounds before it merges. */
  const bumpy = (...learner: FakeStep[]): FakeStep[] => [{ output: TRIAGE() }, buildStep("broken"), buildStep("fixed"), CODE_PASS, ...learner.map((s) => ({ role: "learner", ...s }))];

  const lastMove = (store: Store, runId: string) => store.listEvents(runId).at(-1)!;

  it("skips the learner for a run that went through in one clean round", async () => {
    const { driver, store, fake, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: config() });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toHaveLength(1);
    expect(lastMove(store, run.id)).toMatchObject({
      from_state: "learn",
      to_state: "done",
      reason: "nothing to learn: one round, no failed checks or blocking findings, no human stepped in",
    });
    expect(fake.calls().map((c) => c.role)).not.toContain("learner");
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

  it("does not count a human approving a gate as something to learn from", async () => {
    const { driver, store, fake } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: config("human") });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    const parked = store.getRun(run.id)!;
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, approveTarget(parked)!, {
      comment: "ship it",
      commitSha: waitingCommit(store.listEvents(run.id)),
    });

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id).reason).toMatch(/^nothing to learn/);
    expect(fake.calls().map((c) => c.role)).not.toContain("learner");
  });

  it("asks the learner about a bumpy run and stores its lessons as proposals, without touching lessons.md", async () => {
    const { driver, store, fake, root } = setup(bumpy({ output: learned([LESSON]) }), { config: config() });
    const mainBefore = git(root, "rev-parse", "origin/main");
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({ from_state: "learn", to_state: "done", reason: "1 lesson proposed; see `factory lessons`", data: { lessons: 1 } });
    expect(store.listLessons({ project_id: run.project_id })).toMatchObject([{ run_id: run.id, status: "proposed", ...LESSON }]);

    const dir = runDirOf(root, run.id);
    const learner = fake.calls().find((c) => c.role === "learner")!;
    expect(learner.stdin).toContain(`Output file: \`${join(dir, "learn.md")}\``);
    expect(learner.stdin).toContain("## Why this run is worth a look\n- it took 2 rounds\n- the quality gate failed (round-1/checks.md)");
    expect(learner.stdin).toContain("- gate -> build: quality gate failed (round 1)");
    expect(learner.stdin).toContain("Human decisions:\n(none)");
    expect(learner.stdin).toContain(`- \`${join(dir, "round-1", "checks.md")}\``);
    expect(learner.stdin).toContain(`- \`${join(dir, "round-2", "review-code.md")}\``);
    // Read-only: no shell, and learn.md is the only file it may write.
    const settings = JSON.parse(readFileSync(join(dir, "agent", "learner.settings.json"), "utf8")) as { permissions: { allow: string[]; deny: string[] } };
    expect(settings.permissions.deny).toContain("Bash");
    expect(settings.permissions.allow.filter((rule) => rule.startsWith("Edit") || rule.startsWith("Write"))).toEqual([expect.stringMatching(/learn\.md\)$/)]);
    expect(readFileSync(join(dir, "agent", "learner.md"), "utf8")).toContain("# Role: learner");
    // Nothing reaches the default branch without a human's approval.
    git(root, "fetch", "-q", "origin");
    expect(git(root, "rev-parse", "origin/main")).toBe(mainBefore);
  });

  it("finishes the run when the learner proposes nothing", async () => {
    const { driver, store, root } = setup(bumpy({ output: learned([]) }), { config: config() });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({ to_state: "done", reason: "the learner proposed no lessons", data: { lessons: 0 } });
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
    expect(existsSync(join(runDirOf(root, run.id), "learn.md"))).toBe(true);
  });

  it("never holds up a merged run: a failed learner only skips the lessons, with a warning", async () => {
    const { driver, store, seen } = setup(bumpy({ stream: "error_max_turns" }), { config: config() });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({ from_state: "learn", to_state: "done", reason: expect.stringMatching(/^lessons skipped: learner agent failed/) });
    expect(seen).toContainEqual(expect.objectContaining({ type: "info", message: expect.stringMatching(/^warning: no lessons from this run: learner agent failed/) }));
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

  it("finishes the run without lessons when the usage limit is hit", async () => {
    const { driver, store } = setup(bumpy({ stream: "rate_limited" }), { config: config() });
    const run = driver.startRun(12);

    // Not rate_limited: the merge is done, and there is nothing to continue after the reset.
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({ to_state: "done", reason: expect.stringMatching(/^lessons skipped: usage limit reached \(resets at /) });
  });

  it("finishes the run without lessons when the learner's output is malformed twice", async () => {
    const vague = "LESSONS: 1\n\n## Lessons\n- write better code\n";
    const { driver, store } = setup(bumpy({ output: vague }, { output: vague }), { config: config() });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({
      to_state: "done",
      reason: expect.stringMatching(/^lessons skipped: learner output was rejected twice: ## Lessons must contain a ```json array block/),
    });
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });
});
