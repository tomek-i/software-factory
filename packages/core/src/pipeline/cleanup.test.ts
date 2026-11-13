import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunState } from "@factory/shared";
import { git, GIT_TEST_TIMEOUT, repoWithRemote } from "../../test/helpers.js";
import { createWorktree } from "../git/worktrees.js";
import { Store, type Run } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { CLEANUP_MARKER, cleanupFinishedRuns, cleanupRun } from "./cleanup.js";
import { runDirOf } from "./driver.js";

// Each test drives real git repos; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const BRANCH = "factory/12-add-the-feature";

/**
 * A repo with a finished run: its worktree on BRANCH, optionally with a commit, pushed or not, and
 * an uncommitted change. The run folder exists, as it does for every real run.
 */
function finishedRun(state: RunState, work: { commit?: boolean; push?: boolean; dirty?: boolean } = {}) {
  const { root, remote } = repoWithRemote();
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  let run = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });
  const worktree = createWorktree({ root, runId: run.id, branch: BRANCH, defaultBranch: "main" });
  if (work.commit) {
    writeFileSync(join(worktree.path, "feature.txt"), "fixed\n");
    git(worktree.path, "add", "feature.txt");
    git(worktree.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "feat: the feature");
  }
  if (work.push) git(worktree.path, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
  if (work.dirty) writeFileSync(join(worktree.path, "notes.txt"), "mine\n");
  store.updateRunFields(run.id, { branch: worktree.branch, worktree_path: worktree.path });
  store.writeState(run.id, state);
  run = store.getRun(run.id)!;
  const runDir = runDirOf(root, run.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "build.md"), "report\n");
  const options = { root, runDir, defaultBranch: "main" };
  const remoteHas = () => git(root, "ls-remote", "origin", `refs/heads/${BRANCH}`) !== "";
  const localHas = () => git(root, "branch", "--list", BRANCH) !== "";
  return { root, remote, store, project, run, worktree, runDir, options, remoteHas, localHas };
}

describe("cleanupRun", () => {
  it("removes a merged run's worktree, local and remote branch, and keeps its run folder", () => {
    const { run, worktree, runDir, options, remoteHas, localHas } = finishedRun("done", { commit: true, push: true });
    const result = cleanupRun(run, options);
    expect(result).toEqual({ removed: ["worktree", `local branch ${BRANCH}`, `remote branch ${BRANCH}`], warnings: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(localHas()).toBe(false);
    expect(remoteHas()).toBe(false);
    expect(readFileSync(join(runDir, "build.md"), "utf8")).toBe("report\n");
    expect(JSON.parse(readFileSync(join(runDir, CLEANUP_MARKER), "utf8"))).toMatchObject({ removed: result.removed, kept: null });
  });

  it("leaves the remote alone when GitHub already deleted the merged branch, and throws away leftovers of a merged run", () => {
    const { root, run, worktree, options, localHas } = finishedRun("done", { commit: true, push: true, dirty: true });
    git(root, "push", "--quiet", "origin", "--delete", BRANCH);
    expect(cleanupRun(run, options)).toEqual({ removed: ["worktree", `local branch ${BRANCH}`], warnings: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(localHas()).toBe(false);
  });

  for (const state of ["cancelled", "rejected", "failed"] as const) {
    it(`removes a ${state} run's worktree and local branch when its work is pushed, and keeps the remote branch`, () => {
      const { run, worktree, options, remoteHas, localHas } = finishedRun(state, { commit: true, push: true });
      expect(cleanupRun(run, options)).toEqual({ removed: ["worktree", `local branch ${BRANCH}`], warnings: [] });
      expect(existsSync(worktree.path)).toBe(false);
      expect(localHas()).toBe(false);
      expect(remoteHas()).toBe(true);
    });
  }

  it("removes a cancelled run that never committed anything", () => {
    const { run, worktree, options } = finishedRun("cancelled");
    expect(cleanupRun(run, options).removed).toEqual(["worktree", `local branch ${BRANCH}`]);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("keeps a cancelled run's worktree and branch when they hold work that is not on the remote", () => {
    for (const [work, why] of [
      [{ commit: true, push: true, dirty: true }, "the worktree has uncommitted changes"],
      [{ commit: true }, "the branch has commits that are not on the remote"],
    ] as const) {
      const { run, worktree, runDir, options, localHas } = finishedRun("cancelled", work);
      const result = cleanupRun(run, options);
      expect(result).toEqual({ removed: [], kept: `${why}, so the worktree and branch ${BRANCH} are kept`, warnings: [] });
      expect(existsSync(worktree.path)).toBe(true);
      expect(localHas()).toBe(true);
      // Kept on purpose: later sweeps do not ask again.
      expect(JSON.parse(readFileSync(join(runDir, CLEANUP_MARKER), "utf8"))).toMatchObject({ kept: result.kept });
    }
  });

  it("never deletes a branch with unpushed commits, even when its worktree was removed by hand", () => {
    const { root, run, worktree, options, localHas } = finishedRun("cancelled", { commit: true });
    git(root, "worktree", "remove", "--force", worktree.path);
    expect(cleanupRun(run, options).kept).toMatch(/commits that are not on the remote/);
    expect(localHas()).toBe(true);
  });

  it("turns a failure (a locked worktree) into a warning without a marker, so the next sweep tries again", () => {
    const { run, worktree, runDir, options } = finishedRun("done", { commit: true, push: true });
    const locked: CommandRunner = (cmd, args, opts) =>
      args.includes("remove") ? { code: 1, stdout: "", stderr: `error: failed to delete '${worktree.path}': Permission denied` } : runCommand(cmd, args, opts);
    const result = cleanupRun(run, { ...options, run: locked });
    expect(result.warnings).toEqual([expect.stringMatching(new RegExp(`^could not clean up ${run.id}: git worktree failed: error: failed to delete`))]);
    expect(existsSync(join(runDir, CLEANUP_MARKER))).toBe(false);
    expect(cleanupRun(run, options).warnings).toEqual([]);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("only says what it would do in a dry run", () => {
    const { run, worktree, runDir, options, remoteHas } = finishedRun("done", { commit: true, push: true });
    expect(cleanupRun(run, { ...options, dryRun: true }).removed).toEqual(["worktree", `local branch ${BRANCH}`, `remote branch ${BRANCH}`]);
    expect(existsSync(worktree.path)).toBe(true);
    expect(remoteHas()).toBe(true);
    expect(existsSync(join(runDir, CLEANUP_MARKER))).toBe(false);
  });

  it("does nothing for a run that has not finished", () => {
    const { run, worktree, options } = finishedRun("review", { commit: true, push: true });
    expect(cleanupRun(run, options)).toEqual({ removed: [], warnings: [] });
    expect(existsSync(worktree.path)).toBe(true);
  });
});

describe("cleanupFinishedRuns", () => {
  const later = (run: Run, ms: number) => new Date(new Date(run.updated_at).getTime() + ms);

  it("cleans up runs that finished a while ago, once, and records what it kept in the run's events", () => {
    const { root, store, project, run, worktree } = finishedRun("done", { commit: true, push: true });
    const sweep = (now: Date) => cleanupFinishedRuns(store, project, { defaultBranch: "main", runDirOf: (id) => runDirOf(root, id), now });
    // Just finished: its worker may still be stopping.
    expect(sweep(later(run, 60_000))).toEqual([]);
    expect(existsSync(worktree.path)).toBe(true);
    expect(sweep(later(run, 3 * 60_000))).toEqual([`${run.id}: removed worktree, local branch ${BRANCH}, remote branch ${BRANCH}`]);
    expect(sweep(later(run, 4 * 60_000))).toEqual([]);
  });

  it("stores why it kept a run with unpushed work, and lists without removing in a dry run", () => {
    const kept = finishedRun("cancelled", { commit: true });
    const options = { defaultBranch: "main", runDirOf: (id: string) => runDirOf(kept.root, id), graceMs: 0 };
    expect(cleanupFinishedRuns(kept.store, kept.project, { ...options, dryRun: true })).toEqual([
      `${kept.run.id}: kept: the branch has commits that are not on the remote, so the worktree and branch ${BRANCH} are kept`,
    ]);
    expect(existsSync(join(kept.runDir, CLEANUP_MARKER))).toBe(false);
    cleanupFinishedRuns(kept.store, kept.project, options);
    expect(kept.store.listEvents(kept.run.id).at(-1)).toMatchObject({ from_state: "cancelled", to_state: "cancelled", reason: expect.stringMatching(/^cleanup: kept: the branch has commits/) });
  });

  it("leaves a run alone while a worker still holds its lease", () => {
    const { root, store, project, run, worktree } = finishedRun("cancelled", { commit: true, push: true });
    store.acquireLease(run.id, "worker", 15 * 60_000);
    expect(cleanupFinishedRuns(store, project, { defaultBranch: "main", runDirOf: (id) => runDirOf(root, id), graceMs: 0 })).toEqual([]);
    expect(existsSync(worktree.path)).toBe(true);
  });
});
