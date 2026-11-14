import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RunState } from "@factory/shared";
import { git, GIT_TEST_TIMEOUT, repoWithRemote } from "../../test/helpers.js";
import { createWorktree } from "../git/worktrees.js";
import { Store, type Run } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { CLEANUP_MARKER, CLEANUP_PENDING, cleanupFinishedRuns, cleanupRun, describeCleanup, mergedHeadOf } from "./cleanup.js";
import { runDirOf } from "./driver.js";

// Each test drives real git repos; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const BRANCH = "factory/12-add-the-feature";

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", `feat: ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

/**
 * A repo with a finished run: its worktree on BRANCH, optionally with a commit, pushed or not, and
 * an uncommitted change. A done run is recorded as merged at the pushed commit, as the factory and
 * reconciling a merge on GitHub both record it. The run folder exists, as for every real run.
 */
function finishedRun(state: RunState, work: { commit?: boolean; push?: boolean; dirty?: boolean } = {}) {
  const { root, remote } = repoWithRemote();
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  let run = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });
  const worktree = createWorktree({ root, runId: run.id, branch: BRANCH, defaultBranch: "main" });
  if (work.commit) commit(worktree.path, "feature.txt", "fixed\n");
  const head = git(worktree.path, "rev-parse", "HEAD");
  if (work.push) git(worktree.path, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
  if (work.dirty) writeFileSync(join(worktree.path, "notes.txt"), "mine\n");
  store.updateRunFields(run.id, { branch: worktree.branch, worktree_path: worktree.path });
  store.writeState(run.id, state);
  if (state === "done") store.appendEvent(run.id, "merge", "done", "merged PR #7 on GitHub", { pr: 7, mergeCommit: "c".repeat(40), commit: head });
  run = store.getRun(run.id)!;
  const runDir = runDirOf(root, run.id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "build.md"), "report\n");
  const options = { root, runDir, defaultBranch: "main", ...(state === "done" ? { mergedHead: head } : {}) };
  const remoteHas = () => git(root, "ls-remote", "origin", `refs/heads/${BRANCH}`) !== "";
  const localHas = () => git(root, "branch", "--list", BRANCH) !== "";
  return { root, remote, store, project, run, worktree, head, runDir, options, remoteHas, localHas };
}

describe("cleanupRun", () => {
  it("removes a merged run's worktree, local and remote branch, and keeps its run folder", () => {
    const { store, run, worktree, head, runDir, options, remoteHas, localHas } = finishedRun("done", { commit: true, push: true });
    expect(mergedHeadOf(store, run.id)).toBe(head);
    const result = cleanupRun(run, options);
    expect(result).toEqual({ removed: ["worktree", `local branch ${BRANCH}`, `remote branch ${BRANCH}`], warnings: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(localHas()).toBe(false);
    expect(remoteHas()).toBe(false);
    expect(readFileSync(join(runDir, "build.md"), "utf8")).toBe("report\n");
    expect(JSON.parse(readFileSync(join(runDir, CLEANUP_MARKER), "utf8"))).toMatchObject({ removed: result.removed, kept: null });
    expect(existsSync(join(runDir, CLEANUP_PENDING))).toBe(false);
  });

  it("leaves the remote alone when GitHub already deleted the merged branch", () => {
    const { root, run, options, localHas } = finishedRun("done", { commit: true, push: true });
    git(root, "push", "--quiet", "origin", "--delete", BRANCH);
    expect(cleanupRun(run, options)).toEqual({ removed: ["worktree", `local branch ${BRANCH}`], warnings: [] });
    expect(localHas()).toBe(false);
  });

  it("keeps a merged run's worktree and branch when they hold work that was not merged", () => {
    // Edited in the worktree while the run waited, then merged by hand: the edit was not part of it.
    const dirty = finishedRun("done", { commit: true, push: true, dirty: true });
    expect(cleanupRun(dirty.run, dirty.options).kept).toBe(`the worktree has uncommitted changes, so the worktree and branch ${BRANCH} are kept`);
    expect(existsSync(join(dirty.worktree.path, "notes.txt"))).toBe(true);

    const later = finishedRun("done", { commit: true, push: true });
    commit(later.worktree.path, "after.txt", "after the merge\n");
    expect(cleanupRun(later.run, later.options).kept).toBe(`the branch has commits that were not merged, so the worktree and branch ${BRANCH} are kept`);
    expect(later.localHas()).toBe(true);
    expect(later.remoteHas()).toBe(true);
  });

  it("keeps a merged run's remote branch when someone pushed to it after the merge", () => {
    const { root, remote, run, worktree, options, remoteHas } = finishedRun("done", { commit: true, push: true });
    // A commit pushed from elsewhere (e.g. GitHub's editor), not in the local repository.
    const elsewhere = join(root, "..", "elsewhere");
    git(join(root, ".."), "clone", "--quiet", "--branch", BRANCH, remote, elsewhere);
    commit(elsewhere, "late.txt", "late\n");
    git(elsewhere, "push", "--quiet", "origin", BRANCH);

    const result = cleanupRun(run, options);
    expect(result.removed).toEqual(["worktree", `local branch ${BRANCH}`]);
    expect(result.kept).toBe(`the remote branch ${BRANCH} is not what was merged, so it is kept`);
    expect(existsSync(worktree.path)).toBe(false);
    expect(remoteHas()).toBe(true);
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
      expect(JSON.parse(readFileSync(join(runDir, CLEANUP_MARKER), "utf8"))).toMatchObject({ kept: result.kept });
    }
  });

  it("never deletes a branch with unpushed commits, even when its worktree was removed by hand", () => {
    const { root, run, worktree, options, localHas } = finishedRun("cancelled", { commit: true });
    git(root, "worktree", "remove", "--force", worktree.path);
    expect(cleanupRun(run, options).kept).toMatch(/commits that are not on the remote/);
    expect(localHas()).toBe(true);
  });

  /**
   * What `git worktree remove --force` does on Windows when another process holds a file open: it
   * deletes the worktree's `.git` file and unregisters it, then fails, leaving the other files.
   */
  function lockedRemove(root: string, path: string): CommandRunner {
    return (cmd, args, opts) => {
      if (args[0] !== "worktree" || args[1] !== "remove") return runCommand(cmd, args, opts);
      const gitDir = git(path, "rev-parse", "--absolute-git-dir");
      rmSync(join(path, ".git"));
      rmSync(gitDir, { recursive: true });
      expect(git(root, "worktree", "list")).not.toContain(BRANCH);
      return { code: 255, stdout: "", stderr: `error: failed to delete '${path}': Invalid argument` };
    };
  }

  /** A folder that stays locked on every retry; no real waits between them. */
  function stillLocked(root: string, path: string) {
    const tries: string[] = [];
    const removeFolder = (folder: string) => {
      tries.push(folder);
      throw new Error(`EBUSY: resource busy or locked, rmdir '${folder}'`);
    };
    return { tries, options: { run: lockedRemove(root, path), removeFolder, removeRetryDelayMs: 0 } };
  }

  it("turns a worktree that stays locked into a warning, reports nothing removed, and deletes what is left next time", () => {
    const { root, run, worktree, runDir, options, localHas } = finishedRun("cancelled", { commit: true, push: true });
    const locked = stillLocked(root, worktree.path);
    const result = cleanupRun(run, { ...options, ...locked.options });
    expect(result).toEqual({ removed: [], warnings: [expect.stringMatching(new RegExp(`^could not clean up ${run.id}: git worktree failed: error: failed to delete`))] });
    expect(describeCleanup(run.id, result)).toEqual([`warning: ${result.warnings[0]}`]);
    // The first try is `git worktree remove`, the two retries delete the folder.
    expect(locked.tries).toEqual([worktree.path, worktree.path]);
    expect(existsSync(join(worktree.path, "feature.txt"))).toBe(true);
    expect(localHas()).toBe(true);
    expect(existsSync(join(runDir, CLEANUP_MARKER))).toBe(false);
    expect(existsSync(join(runDir, CLEANUP_PENDING))).toBe(true);

    expect(cleanupRun(run, options)).toEqual({ removed: ["worktree", `local branch ${BRANCH}`], warnings: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(localHas()).toBe(false);
    expect(existsSync(join(runDir, CLEANUP_PENDING))).toBe(false);
  });

  it("removes a locked worktree when a retry succeeds", () => {
    const { root, run, worktree, runDir, options, localHas } = finishedRun("cancelled", { commit: true, push: true });
    const result = cleanupRun(run, { ...options, run: lockedRemove(root, worktree.path), removeRetryDelayMs: 0 });
    expect(result).toEqual({ removed: ["worktree", `local branch ${BRANCH}`], warnings: [] });
    expect(existsSync(worktree.path)).toBe(false);
    expect(localHas()).toBe(false);
    expect(git(root, "worktree", "list")).not.toContain(BRANCH);
    expect(JSON.parse(readFileSync(join(runDir, CLEANUP_MARKER), "utf8"))).toMatchObject({ removed: result.removed, kept: null });
    expect(existsSync(join(runDir, CLEANUP_PENDING))).toBe(false);
  });

  it("reports only the worktree as removed when deleting the branch fails afterwards", () => {
    const { run, worktree, runDir, options, localHas } = finishedRun("cancelled", { commit: true, push: true });
    const refused: CommandRunner = (cmd, args, opts) =>
      args[0] === "branch" && args[1] === "-D" ? { code: 1, stdout: "", stderr: `error: cannot delete branch '${BRANCH}'` } : runCommand(cmd, args, opts);
    const result = cleanupRun(run, { ...options, run: refused });
    expect(result).toEqual({ removed: ["worktree"], warnings: [`could not clean up ${run.id}: git branch -D ${BRANCH} failed: error: cannot delete branch '${BRANCH}'`] });
    expect(describeCleanup(run.id, result)[0]).toBe(`${run.id}: removed worktree`);
    expect(existsSync(worktree.path)).toBe(false);
    expect(localHas()).toBe(true);
    expect(existsSync(join(runDir, CLEANUP_MARKER))).toBe(false);
    expect(existsSync(join(runDir, CLEANUP_PENDING))).toBe(true);
  });

  it("does not report the remote branch as removed when deleting it fails", () => {
    const { run, options, localHas, remoteHas } = finishedRun("done", { commit: true, push: true });
    const rejected: CommandRunner = (cmd, args, opts) =>
      args[0] === "push" ? { code: 1, stdout: "", stderr: "error: failed to push some refs" } : runCommand(cmd, args, opts);
    const result = cleanupRun(run, { ...options, run: rejected });
    expect(result).toEqual({ removed: ["worktree", `local branch ${BRANCH}`], warnings: [`could not clean up ${run.id}: git push --delete ${BRANCH} failed: error: failed to push some refs`] });
    expect(localHas()).toBe(false);
    expect(remoteHas()).toBe(true);
  });

  it("keeps a folder that is no longer a git worktree when it did not start removing it", () => {
    const { root, run, worktree, runDir, options } = finishedRun("cancelled", { commit: true, push: true });
    cleanupRun(run, { ...options, ...stillLocked(root, worktree.path).options });
    rmSync(join(runDir, CLEANUP_PENDING));
    // git commands in the folder now act on the main repository, so its files cannot be judged.
    expect(cleanupRun(run, options).kept).toBe(`the worktree folder is no longer a git worktree, so the worktree and branch ${BRANCH} are kept`);
    expect(existsSync(join(worktree.path, "feature.txt"))).toBe(true);
  });

  it("still checks the branch when finishing a half-done removal", () => {
    // The branch could not be deleted (checked out elsewhere); meanwhile someone committed on it.
    const { root, run, worktree, runDir, options, localHas } = finishedRun("cancelled", { commit: true, push: true });
    rmSync(worktree.path, { recursive: true });
    git(root, "worktree", "prune");
    writeFileSync(join(runDir, CLEANUP_PENDING), "{}\n");
    git(root, "checkout", "--quiet", BRANCH);
    commit(root, "later.txt", "not pushed\n");
    git(root, "checkout", "--quiet", "main");

    expect(cleanupRun(run, options).kept).toMatch(/commits that are not on the remote/);
    expect(localHas()).toBe(true);
  });

  it("keeps a worktree whose HEAD has commits on no branch", () => {
    // A detached HEAD, e.g. a rebase stopped half way: the branch itself is pushed.
    const { run, worktree, options } = finishedRun("cancelled", { commit: true, push: true });
    git(worktree.path, "checkout", "--quiet", "--detach");
    commit(worktree.path, "detached.txt", "only here\n");
    expect(cleanupRun(run, options).kept).toMatch(/commits that are not on the remote/);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("does not take an unreachable remote for a deleted branch", () => {
    const { run, worktree, runDir, options, localHas } = finishedRun("done", { commit: true, push: true });
    const timeouts: (number | undefined)[] = [];
    const offline: CommandRunner = (cmd, args, opts) => {
      if (args[0] !== "ls-remote") return runCommand(cmd, args, opts);
      timeouts.push(opts.timeoutMs);
      return { code: 128, stdout: "", stderr: "fatal: unable to access 'origin': Could not resolve host" };
    };
    expect(cleanupRun(run, { ...options, run: offline }).warnings).toEqual([`could not clean up ${run.id}: git ls-remote failed: fatal: unable to access 'origin': Could not resolve host`]);
    expect(existsSync(worktree.path)).toBe(true);
    expect(localHas()).toBe(true);
    expect(existsSync(join(runDir, CLEANUP_MARKER))).toBe(false);
    // A hung remote or a credential prompt must not hang the caller.
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((t) => t !== undefined && t > 0)).toBe(true);
  });

  it("only says what it would do in a dry run", () => {
    const { run, worktree, runDir, options, remoteHas } = finishedRun("done", { commit: true, push: true });
    expect(cleanupRun(run, { ...options, dryRun: true }).removed).toEqual(["worktree", `local branch ${BRANCH}`, `remote branch ${BRANCH}`]);
    expect(existsSync(worktree.path)).toBe(true);
    expect(remoteHas()).toBe(true);
    expect(existsSync(join(runDir, CLEANUP_MARKER))).toBe(false);
    expect(existsSync(join(runDir, CLEANUP_PENDING))).toBe(false);
  });

  it("does nothing for a run that has not finished", () => {
    const { run, worktree, options } = finishedRun("review", { commit: true, push: true });
    expect(cleanupRun(run, options)).toEqual({ removed: [], warnings: [] });
    expect(existsSync(worktree.path)).toBe(true);
  });
});

describe("cleanupFinishedRuns", () => {
  const later = (run: Run, ms: number) => new Date(new Date(run.updated_at).getTime() + ms);

  it("cleans up runs that finished a while ago, once, with the merged head from the run's events", () => {
    const { root, store, project, run, worktree, remoteHas } = finishedRun("done", { commit: true, push: true });
    const sweep = (now: Date) => cleanupFinishedRuns(store, project, { defaultBranch: "main", runDirOf: (id) => runDirOf(root, id), now });
    // Just finished: its worker may still be stopping.
    expect(sweep(later(run, 60_000))).toEqual([]);
    expect(existsSync(worktree.path)).toBe(true);
    expect(sweep(later(run, 3 * 60_000))).toEqual([`${run.id}: removed worktree, local branch ${BRANCH}, remote branch ${BRANCH}`]);
    expect(remoteHas()).toBe(false);
    expect(sweep(later(run, 4 * 60_000))).toEqual([]);
  });

  it("leaves a run alone while a worker still holds its lease", () => {
    const { root, store, project, run, worktree } = finishedRun("cancelled", { commit: true, push: true });
    const at = later(run, 3 * 60_000);
    expect(store.acquireLease(run.id, "worker", 10 * 60_000)).toBe(true);
    const sweep = () => cleanupFinishedRuns(store, project, { defaultBranch: "main", runDirOf: (id) => runDirOf(root, id), now: at, graceMs: 0 });
    expect(sweep()).toEqual([]);
    expect(existsSync(worktree.path)).toBe(true);
    store.releaseLease(run.id, "worker");
    expect(sweep()).toEqual([`${run.id}: removed worktree, local branch ${BRANCH}`]);
  });

  it("records why it kept a run once, lists without removing in a dry run, and looks again when asked", () => {
    const kept = finishedRun("cancelled", { commit: true });
    const options = { defaultBranch: "main", runDirOf: (id: string) => runDirOf(kept.root, id), graceMs: 0 };
    const why = `${kept.run.id}: kept: the branch has commits that are not on the remote, so the worktree and branch ${BRANCH} are kept`;
    expect(cleanupFinishedRuns(kept.store, kept.project, { ...options, dryRun: true })).toEqual([why]);
    expect(existsSync(join(kept.runDir, CLEANUP_MARKER))).toBe(false);
    expect(kept.store.listEvents(kept.run.id).some((e) => e.reason.startsWith("cleanup:"))).toBe(false);

    expect(cleanupFinishedRuns(kept.store, kept.project, options)).toEqual([why]);
    // Kept on purpose: the sweep in `factory status` does not ask again...
    expect(cleanupFinishedRuns(kept.store, kept.project, options)).toEqual([]);
    // ...`factory cleanup` does, and its second "kept" is not stored again.
    expect(cleanupFinishedRuns(kept.store, kept.project, { ...options, recheckKept: true })).toEqual([why]);
    expect(kept.store.listEvents(kept.run.id).filter((e) => e.reason.startsWith("cleanup:")).map((e) => e.reason)).toEqual([
      `cleanup: kept: the branch has commits that are not on the remote, so the worktree and branch ${BRANCH} are kept`,
    ]);

    // Pushed since: `factory cleanup` now removes it.
    git(kept.worktree.path, "push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
    expect(cleanupFinishedRuns(kept.store, kept.project, { ...options, recheckKept: true })).toEqual([`${kept.run.id}: removed worktree, local branch ${BRANCH}`]);
  });
});
