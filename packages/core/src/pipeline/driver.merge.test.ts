import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import { approve, CODE_PASS, mergeConfig, moves } from "../../test/merge-setup.js";
import { runDirOf, waitingCommit } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver after the reviews: capture, PR and merge", () => {
  const PROCEED = "DECISION: PROCEED\n\n## Summary\n- does what the issue asks\n";

  it("goes on from clear reviews to a ready PR and waits at the merge gate, then merges the commit that waited", async () => {
    const { driver, store, pr, merges, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    const parked = store.getRun(run.id)!;
    const head = git(parked.worktree_path!, "rev-parse", "HEAD");
    expect(parked).toMatchObject({ waiting_gate: "merge", parked_from: "merge" });
    expect(moves(store, run.id).slice(-5)).toEqual(["gate>review", "review>capture", "capture>pr", "pr>merge", "merge>needs_human"]);
    expect(waitingCommit(store.listEvents(run.id))).toBe(head);
    expect(pr.draft).toBe(false);
    expect(merges).toEqual([]);

    approve(store, run.id);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toEqual([{ number: 7, head }]);
    expect(moves(store, run.id).slice(-3)).toEqual(["needs_human>merge", "merge>learn", "learn>done"]);
    expect(store.listEvents(run.id).find((e) => e.to_state === "learn")!.data).toMatchObject({ pr: 7, commit: head, mergeCommit: "e".repeat(40) });
    expect(store.listDecisions(run.id)).toMatchObject([
      { gate: "triage", outcome: "proceed" },
      { gate: "review", outcome: "proceed", actor: "agent", comment: "reviews: code PASS", commit_sha: head },
      { gate: "pr", outcome: "proceed", actor: "system", commit_sha: head },
      { gate: "merge", outcome: "escalate", comment: "gate is set to human" },
      { gate: "merge", outcome: "approve", actor: "human", commit_sha: head },
    ]);
    // Nothing on main changed, so no second gate ran.
    expect(existsSync(join(runDirOf(root, run.id), "round-1", "resync", "checks.md"))).toBe(false);
  });

  it("asks the approver in auto mode and merges when it says PROCEED", async () => {
    const { driver, store, merges, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, { role: "approver", output: PROCEED }], {
      config: mergeConfig("merge: auto"),
    });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    const dir = runDirOf(root, run.id);
    const approver = fake.calls().find((c) => c.role === "approver")!;
    const head = merges[0]!.head;
    expect(approver.stdin).toContain(`Final commit: \`${head}\``);
    expect(approver.stdin).toContain(join(dir, "approval.diff"));
    expect(approver.stdin).toContain(join(dir, "round-1", "review-code.md"));
    expect(readFileSync(join(dir, "approval.diff"), "utf8")).toContain("feature.txt");
    expect(store.listDecisions(run.id).at(-1)).toMatchObject({ gate: "merge", outcome: "proceed", actor: "agent", comment: "the approver said PROCEED", commit_sha: head });
  });

  it("waits at the merge gate with the approver's reasons when it says ESCALATE", async () => {
    const escalate = "DECISION: ESCALATE\n\n## Summary\n- unsure\n\n## Reasons\n- the issue leaves the price open\n- no test for the empty case\n";
    const { driver, store, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, { role: "approver", output: escalate }], {
      config: mergeConfig("merge: auto"),
    });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({
      kind: "parked",
      reason: "waiting at merge gate: the issue leaves the price open; no test for the empty case",
    });
    expect(store.getRun(run.id)!.waiting_gate).toBe("merge");
    expect(merges).toEqual([]);
  });

  it("merges without asking anyone when the merge gate is set to always", async () => {
    const { driver, merges, fake } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toHaveLength(1);
    expect(fake.calls().map((c) => c.role)).not.toContain("approver");
  });

  it("still needs a human at the merge gate for hard rules, even when it is set to always", async () => {
    const touchInfra: FakeStep = { ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "infra/main.tf": "x\n" } };
    const { driver, store, merges } = setup([{ output: TRIAGE() }, touchInfra, CODE_PASS], { config: mergeConfig("merge: always") });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringMatching(/^waiting at review gate: .*hard rule: protected path/) });
    approve(store, run.id);
    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at merge gate: hard rule: protected path (infra/**): infra/main.tf" });
    expect(merges).toEqual([]);
  });

  it("finishes the run when its PR was merged on GitHub before the factory got to it", async () => {
    const { driver, store, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("pr: human") });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    Object.assign(pr, { state: "merged", mergeCommit: "f".repeat(40) });
    approve(store, run.id);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toEqual([]);
    expect(store.listDecisions(run.id).at(-1)).toMatchObject({ gate: "merge", actor: "human", comment: "merged PR #7 on GitHub", commit_sha: "f".repeat(40) });
  });

  it("does not merge a run that was cancelled while the merge stage ran", async () => {
    const { driver, store, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    const run = driver.startRun(12);
    // The third look at the PR is the one just before merging: cancel then.
    pr.onView = (count) => {
      if (count === 3) new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(run.id, "stop");
    };

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "cancelled" });
    expect(merges).toEqual([]);
  });

  it("squash-merges when merge.method says so", async () => {
    const { driver, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always", "merge:\n  method: squash\n") });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toEqual([expect.objectContaining({ number: 7, method: "squash" })]);
  });
});
