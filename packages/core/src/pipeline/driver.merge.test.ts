import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema, parseVerdict } from "@factory/shared";
import { buildStep, CHECK_JS, READY, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, REVIEW_PASS, type FakeStep } from "../../test/helpers.js";
import { Store } from "../store/store.js";
import { approveTarget, runDirOf, waitingCommit } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver after the reviews: capture, PR and merge", () => {
  /** One review lens, so a round is quick; `gates` sets the PR and merge gates. */
  const mergeConfig = (gates: string, extra = "") =>
    `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n${gates
      .split("\n")
      .map((g) => `  ${g}\n`)
      .join("")}reviews:\n  always: [code]\n  ui: []\n${extra}`;
  const CODE_PASS: FakeStep = { role: "reviewer-code", output: REVIEW_PASS };
  const PROCEED = "DECISION: PROCEED\n\n## Summary\n- does what the issue asks\n";

  /** A human approves the gate the run waits at, naming the commit when it is the merge gate. */
  function approve(store: Store, runId: string) {
    const run = store.getRun(runId)!;
    const commitSha = run.waiting_gate === "merge" ? waitingCommit(store.listEvents(runId)) : undefined;
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(runId, approveTarget(run, "build")!, { comment: "go", commitSha });
  }

  /** Commit a change straight to main on origin, as if another PR had been merged meanwhile. */
  function landOnMain(root: string, files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "chore: meanwhile on main");
    git(root, "push", "-q", "origin", "main");
  }

  const moves = (store: Store, runId: string) => store.listEvents(runId).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);

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

  it("merges the latest main in, checks the result again, and keeps the approval when only main's changes came in", async () => {
    const { driver, store, merges, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    const approved = waitingCommit(store.listEvents(run.id))!;
    landOnMain(root, { "other.txt": "meanwhile\n" });

    approve(store, run.id);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });

    const worktree = store.getRun(run.id)!.worktree_path!;
    const head = git(worktree, "rev-parse", "HEAD");
    expect(head).not.toBe(approved);
    expect(git(worktree, "rev-parse", "HEAD^1")).toBe(approved);
    expect(existsSync(join(worktree, "other.txt"))).toBe(true);
    const resynced = parseVerdict("checks", readFileSync(join(runDirOf(root, run.id), "round-1", "resync", "checks.md"), "utf8"));
    expect(resynced.header).toEqual({ GATE: "PASS", COMMIT: head });
    // The merge commit was pushed before GitHub was asked to merge exactly it.
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature").split(/\s+/)[0]).toBe(head);
    expect(merges).toEqual([{ number: 7, head }]);
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

  it("sends a conflict with main back to the builder, and a new commit needs a fresh approval", async () => {
    // The builder resolves the conflict by merging main and keeping its own side.
    const resolve: FakeStep = { exec: [["git", "merge", "-X", "ours", "--no-edit", "origin/main"]], output: READY };
    const { driver, store, merges, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, resolve, CODE_PASS], {
      config: mergeConfig("merge: human"),
    });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    landOnMain(root, { "feature.txt": "something else\n" });
    approve(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    expect(merges).toEqual([]);
    const back = store.listEvents(run.id).find((e) => e.from_state === "merge" && e.to_state === "build")!;
    expect(back).toMatchObject({ reason: "merging main into the branch conflicts in feature.txt", data: { round: 1, conflicts: ["feature.txt"] } });
    expect(store.getRun(run.id)).toMatchObject({ round: 2, review_rounds: 1 });
    const rebuilt = fake.calls().filter((c) => c.role === "builder")[1]!;
    expect(rebuilt.stdin).toContain("Merging origin/main conflicts in:\n\n- feature.txt");
    expect(rebuilt.stdin).toContain("Merge origin/main into your branch with git merge");
    // The merge was undone, so the worktree is clean for the builder.
    expect(git(store.getRun(run.id)!.worktree_path!, "status", "--porcelain")).toBe("");
  });

  it("stops at the review round cap when main still conflicts", async () => {
    const { driver, store, root, pr } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], {
      config: mergeConfig("pr: human\nmerge: always", "loops:\n  max_review_rounds: 1\n"),
    });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at pr gate: gate is set to human" });
    landOnMain(root, { "feature.txt": "something else\n" });
    approve(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({
      kind: "parked",
      reason: "still cannot merge after round 1: review round cap reached (1)",
    });
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "merge", waiting_gate: null });
    // Approving the PR gate skips the PR stage, so the merge stage takes the PR out of draft.
    expect(pr.draft).toBe(false);
  });

  it("sends a quality gate that fails after the re-sync back to the builder with its report", async () => {
    // Checked first: CHECK_JS ends by exiting.
    const needsExtra = `if (!require("fs").existsSync("extra.txt")) { console.error("extra.txt is missing"); process.exit(1); }\n${CHECK_JS}`;
    const addExtra: FakeStep = {
      files: { "extra.txt": "x\n" },
      exec: [
        ["git", "add", "-A"],
        ["git", "commit", "-qm", "fix: extra"],
      ],
      output: READY,
    };
    const { driver, store, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, addExtra, CODE_PASS], {
      config: mergeConfig("pr: human\nmerge: always"),
    });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    landOnMain(root, { "check.js": needsExtra });
    approve(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at pr gate: gate is set to human" });
    const rebuilt = fake.calls().filter((c) => c.role === "builder")[1]!;
    expect(rebuilt.stdin).toContain("After origin/main was merged into your branch, the quality gate failed in round 1. Its report:");
    expect(rebuilt.stdin).toContain("extra.txt is missing");
    expect(store.getRun(run.id)).toMatchObject({ round: 2, review_rounds: 1 });
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

  it("pushes a re-synced commit whose push failed before, and an approval survives the escalation in between", async () => {
    const { driver, store, merges, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    const approved = waitingCommit(store.listEvents(run.id))!;
    landOnMain(root, { "other.txt": "meanwhile\n" });
    // The remote refuses every push for now.
    const hook = join(git(root, "remote", "get-url", "origin"), "hooks", "pre-receive");
    // The remote is a copy of a template repo, which may come without a hooks folder.
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    approve(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringMatching(/^error in merge: git push failed/) });
    const head = git(store.getRun(run.id)!.worktree_path!, "rev-parse", "HEAD");
    expect(head).not.toBe(approved);

    rmSync(hook);
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "merge", { comment: "the remote is back" });
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toEqual([{ number: 7, head }]);
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature").split(/\s+/)[0]).toBe(head);
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

  it("reports git's own error when merging main fails without conflicts", async () => {
    const { driver, store, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("pr: human\nmerge: always") });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    landOnMain(root, { "README.md": "# demo, changed on main\n" });
    writeFileSync(join(store.getRun(run.id)!.worktree_path!, "README.md"), "# demo, changed locally\n");
    approve(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringMatching(/^error in merge: git merge origin\/main failed: .*local changes/s) });
  });

  it("squash-merges when merge.method says so", async () => {
    const { driver, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always", "merge:\n  method: squash\n") });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toEqual([expect.objectContaining({ number: 7, method: "squash" })]);
  });

  it("waits for required checks that are still running, then merges", async () => {
    const { driver, store, pr, merges, seen } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    const ci = (bucket: "pending" | "pass") => [{ name: "test (ubuntu-latest)", bucket }, { name: "pr-title", bucket: "pass" as const }];
    pr.checks = [ci("pending"), ci("pending"), ci("pass")];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toHaveLength(1);
    expect(store.listEvents(run.id).some((e) => e.to_state === "needs_human")).toBe(false);
    const waits = seen.filter((e) => JSON.stringify(e).includes("waiting for required checks on PR #7: test (ubuntu-latest)"));
    expect(waits).toHaveLength(1);
  });

  it("hands a failed required check to a human, naming it, and does not merge", async () => {
    const { driver, store, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.checks = [[{ name: "test (windows-latest)", bucket: "pending" }], [{ name: "test (windows-latest)", bucket: "fail", link: "https://ci/9" }]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required check failed on PR #7: test (windows-latest) (https://ci/9)" });
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "merge" });
    expect(merges).toEqual([]);
  });

  it("stops waiting after merge.checks_timeout_min and asks a human", async () => {
    const { driver, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], {
      config: mergeConfig("merge: always", "merge:\n  checks_timeout_min: 0.002\n"),
    });
    pr.checks = [[{ name: "test (ubuntu-latest)", bucket: "pending" }]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required checks still running on PR #7 after 0.002 min: test (ubuntu-latest)" });
    expect(merges).toEqual([]);
  });

  it("asks a human when the required checks cannot be read", async () => {
    const { driver, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.checksError = "gh pr checks failed: HTTP 502";
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "could not merge PR #7: gh pr checks failed: HTTP 502" });
    expect(merges).toEqual([]);
  });

  it("hands over to a human when GitHub refuses the merge", async () => {
    const { driver, store, pr } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.mergeError = "required status checks are pending";
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "could not merge PR #7: required status checks are pending" });
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "merge" });
  });
});
