import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema, parseVerdict } from "@factory/shared";
import { buildStep, CHECK_JS, READY, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import { approve, CODE_PASS, landOnMain, mergeConfig } from "../../test/merge-setup.js";
import { runDirOf, waitingCommit } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver merge stage: bringing in the latest default branch", () => {
  it("merges the latest main in, checks the result again, and keeps the approval when only main's changes came in", async () => {
    const { driver, store, merges, root, remote } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    const approved = waitingCommit(store.listEvents(run.id))!;
    landOnMain(root, { "other.txt": "meanwhile\n" });

    approve(store, run.id);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    // The approval covered the re-synced commit: nobody was asked again.
    expect(store.listDecisions(run.id).filter((d) => d.gate === "merge").map((d) => d.outcome)).toEqual(["escalate", "approve"]);
    expect(store.listEvents(run.id).filter((e) => e.to_state === "needs_human")).toHaveLength(1);
    expect(store.getRun(run.id)).toMatchObject({ resync_rounds: 0, review_rounds: 0 });

    // The finished run's worktree and branches are gone (see cleanup); its commits stay in the history.
    const worktree = store.getRun(run.id)!.worktree_path!;
    expect(existsSync(worktree)).toBe(false);
    const head = merges[0]!.head;
    expect(head).not.toBe(approved);
    expect(git(root, "rev-parse", `${head}^1`)).toBe(approved);
    expect(git(root, "cat-file", "-t", `${head}:other.txt`)).toBe("blob");
    const resynced = parseVerdict("checks", readFileSync(join(runDirOf(root, run.id), "round-1", "resync", "checks.md"), "utf8"));
    expect(resynced.header).toEqual({ GATE: "PASS", COMMIT: head });
    // The merge commit was pushed before GitHub was asked to merge exactly it (the branch itself is
    // deleted once the run is done, the commit stays on the remote).
    expect(git(remote, "cat-file", "-t", head)).toBe("commit");
    expect(merges).toEqual([{ number: 7, head }]);
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature")).toBe("");
  });

  it("sends a conflict with main back to the builder, and a new commit needs a fresh approval", async () => {
    // The builder resolves the conflict by merging main and keeping its own side.
    const resolve: FakeStep = { exec: [["git", "merge", "-X", "ours", "--no-edit", "origin/main"]], output: READY };
    const { driver, store, merges, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, resolve, CODE_PASS], {
      config: mergeConfig("merge: human"),
    });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    const approved = waitingCommit(store.listEvents(run.id))!;
    landOnMain(root, { "feature.txt": "something else\n" });
    approve(store, run.id);

    // The builder's resolution is the branch's own commit, so the human is asked again, and told why.
    expect(await driver.drive(run.id)).toMatchObject({
      kind: "parked",
      reason: `waiting at merge gate: gate is set to human; approved at ${approved.slice(0, 7)}, then main conflicted in feature.txt; the builder resolved it`,
    });
    expect(merges).toEqual([]);
    const back = store.listEvents(run.id).find((e) => e.from_state === "merge" && e.to_state === "build")!;
    expect(back).toMatchObject({ reason: "merging main into the branch conflicts in feature.txt", data: { round: 1, conflicts: ["feature.txt"] } });
    // A re-sync round, not a review round.
    expect(store.getRun(run.id)).toMatchObject({ round: 2, resync_rounds: 1, review_rounds: 0, build_iterations: 0 });
    const rebuilt = fake.calls().filter((c) => c.role === "builder")[1]!;
    expect(rebuilt.stdin).toContain("Merging origin/main conflicts in:\n\n- feature.txt");
    expect(rebuilt.stdin).toContain("Merge origin/main into your branch with git merge");
    // The merge was undone, so the worktree is clean for the builder.
    expect(git(store.getRun(run.id)!.worktree_path!, "status", "--porcelain")).toBe("");
  });

  it("stops at the re-sync cap when main still conflicts", async () => {
    const { driver, store, root, pr } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], {
      config: mergeConfig("pr: human\nmerge: always", "loops:\n  max_resyncs: 1\n"),
    });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at pr gate: gate is set to human" });
    landOnMain(root, { "feature.txt": "something else\n" });
    approve(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({
      kind: "parked",
      reason: "still cannot merge after round 1: re-sync round cap reached (1)",
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
      // Neither cap is touched by a failed re-sync.
      config: mergeConfig("pr: human\nmerge: always", "loops:\n  max_review_rounds: 1\n  max_build_iterations: 1\n"),
    });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    landOnMain(root, { "check.js": needsExtra });
    approve(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at pr gate: gate is set to human" });
    const rebuilt = fake.calls().filter((c) => c.role === "builder")[1]!;
    expect(rebuilt.stdin).toContain("After origin/main was merged into your branch, the quality gate failed in round 1. Its report:");
    expect(rebuilt.stdin).toContain("extra.txt is missing");
    expect(store.getRun(run.id)).toMatchObject({ round: 2, resync_rounds: 1, review_rounds: 0, build_iterations: 0 });
    const back = store.listEvents(run.id).find((e) => e.from_state === "merge" && e.to_state === "build")!;
    expect(back.data).toMatchObject({ round: 1, resync: true, fingerprint: expect.stringMatching(/^gate:/) });
  });

  it("pushes a re-synced commit whose push failed before, and an approval survives the escalation in between", async () => {
    const { driver, store, merges, root, remote } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
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
    expect(git(remote, "cat-file", "-t", head)).toBe("commit");
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
});
