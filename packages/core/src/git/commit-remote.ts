import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../util/exec.js";

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface CommitToRemoteOptions {
  root: string;
  run: CommandRunner;
  /** The remote branch the commit starts from, freshly fetched. */
  base: string;
  /** The remote branch it is pushed to (`base` itself, or a new branch). */
  branch: string;
  /** Called with the fetched commit of `base`, before anything is written: may throw to stop. */
  check?: (baseCommit: string) => void;
  /** Writes the files in the worktree and returns their repo-relative paths. */
  write: (worktree: string) => string[];
  message: string;
  /** What is committed, for the error when a hook refuses it, e.g. "the lessons commit". */
  what: string;
  tempPrefix: string;
}

/**
 * Commit files on top of a freshly fetched remote branch and push the commit, in a temporary
 * worktree that is removed afterwards, so the user's working copy is never touched. The push is
 * never forced: a remote that moved meanwhile, or branch protection, refuses it. The commit runs the
 * repository's own hooks and signing; they are never skipped. Returns the pushed commit.
 */
export function commitToRemote(options: CommitToRemoteOptions): string {
  const { root, run, base, branch } = options;
  const git = (args: string[], cwd = root) => {
    const result = run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout || "unknown error"}`);
    return result.stdout;
  };

  git(["fetch", "--quiet", "--", "origin", base]);
  // Everything below works from this commit, not the ref: another fetch (a worker's, say) may move the ref meanwhile.
  const baseCommit = git(["rev-parse", `origin/${base}`]).trim();
  options.check?.(baseCommit);
  const dir = mkdtempSync(join(tmpdir(), options.tempPrefix));
  const worktree = join(dir, "worktree");
  let added = false;
  try {
    // Detached: no local branch is left behind; the commit only goes to the remote branch.
    git(["worktree", "add", "--quiet", "--detach", worktree, baseCommit]);
    added = true;
    git(["add", "--", ...options.write(worktree)], worktree);
    try {
      git(["commit", "--quiet", "-m", options.message], worktree);
    } catch (err) {
      throw new Error(
        `a commit hook or commit signing in this repository refused ${options.what} (they are never skipped), so nothing was pushed: ${(err as Error).message}`,
      );
    }
    const commit = git(["rev-parse", "HEAD"], worktree).trim();
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], worktree);
    return commit;
  } finally {
    // Best effort: cleaning up must neither hide the error that got us here nor undo a pushed commit.
    if (added) run("git", ["worktree", "remove", "--force", worktree], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp folder is harmless; the OS cleans its temp directory.
    }
    run("git", ["worktree", "prune"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  }
}
