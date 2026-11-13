import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminal } from "@factory/shared";
import { removeWorktree, type Worktree } from "../git/worktrees.js";
import type { Project, Run, Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";

/** In the run folder once a finished run's worktree and branches were dealt with; sweeps skip it. */
export const CLEANUP_MARKER = "cleanup.json";

/** A sweep leaves runs that finished this recently to the worker that finished them, which may still be stopping. */
export const CLEANUP_GRACE_MS = 2 * 60_000;

export interface CleanupResult {
  /** What was removed, for the output: "worktree", "local branch factory/12-x", "remote branch factory/12-x". */
  removed: string[];
  /** Why the worktree and branch were kept on purpose (work that is not on the remote). */
  kept?: string;
  /** What went wrong; the next sweep tries again. */
  warnings: string[];
}

export interface CleanupOptions {
  /** The repository the run's worktree belongs to. */
  root: string;
  /** The run's folder (`.factory/runs/<run>`), where the marker goes. */
  runDir: string;
  defaultBranch: string;
  run?: CommandRunner;
  /** Say what would happen, change nothing. */
  dryRun?: boolean;
}

function git(run: CommandRunner, cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = run("git", args, { cwd });
  return { ok: result.code === 0, out: result.stdout.trim(), err: (result.stderr || result.stdout).trim().split("\n")[0] ?? "" };
}

/**
 * Why the run's work would be lost with its worktree and local branch, or undefined when it is all
 * on the remote: no uncommitted changes, and the branch's commits pushed (or none beyond the
 * default branch). The branch is read from the repository, so a worktree removed by hand does not
 * hide unpushed commits. Throws when git cannot tell (e.g. the remote is unreachable).
 */
function unsafeToRemove(root: string, worktree: Worktree, defaultBranch: string, run: CommandRunner): string | undefined {
  if (existsSync(worktree.path)) {
    const status = git(run, worktree.path, ["status", "--porcelain"]);
    if (!status.ok) throw new Error(`git status failed: ${status.err}`);
    if (status.out !== "") return "the worktree has uncommitted changes";
  }
  const local = git(run, root, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}^{commit}`]);
  if (!local.ok) return undefined; // no branch, nothing to lose
  const ahead = git(run, root, ["rev-list", "--count", `origin/${defaultBranch}..${local.out}`]);
  if (ahead.ok && ahead.out === "0") return undefined;
  const remote = git(run, root, ["ls-remote", "origin", `refs/heads/${worktree.branch}`]);
  if (!remote.ok) throw new Error(`git ls-remote failed: ${remote.err}`);
  const remoteSha = remote.out.split(/\s+/)[0] ?? "";
  if (remoteSha === local.out) return undefined;
  // The remote branch moved on from ours (e.g. a commit pushed from GitHub): ours is safe if it is in its history.
  if (remoteSha && git(run, root, ["merge-base", "--is-ancestor", local.out, remoteSha]).ok) return undefined;
  return "the branch has commits that are not on the remote";
}

/**
 * Remove a finished run's worktree and branches, never its run folder.
 * - done (its PR was merged): the worktree, the local branch, and the remote branch if GitHub has
 *   not deleted it already. The work is on the default branch.
 * - rejected, cancelled, failed: the worktree and the local branch, only when all the work is on the
 *   remote; the remote branch stays, so a closed PR can be reopened. Otherwise both are kept.
 * Never throws: a failure (a file locked on Windows, git refusing) is a warning and leaves no
 * marker, so the next sweep tries again.
 */
export function cleanupRun(target: Run, options: CleanupOptions): CleanupResult {
  const run = options.run ?? runCommand;
  const result: CleanupResult = { removed: [], warnings: [] };
  if (!isTerminal(target.state) || !target.worktree_path || !target.branch) return result;
  const worktree: Worktree = { path: target.worktree_path, branch: target.branch };
  const { root } = options;
  try {
    const merged = target.state === "done";
    if (!merged) {
      const why = unsafeToRemove(root, worktree, options.defaultBranch, run);
      if (why) {
        result.kept = `${why}, so the worktree and branch ${worktree.branch} are kept`;
        if (!options.dryRun) writeMarker(options.runDir, result);
        return result;
      }
    }
    const localBranch = git(run, root, ["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`]).ok;
    const remoteBranch = merged && git(run, root, ["ls-remote", "--exit-code", "origin", `refs/heads/${worktree.branch}`]).ok;
    if (existsSync(worktree.path)) result.removed.push("worktree");
    if (localBranch) result.removed.push(`local branch ${worktree.branch}`);
    if (remoteBranch) result.removed.push(`remote branch ${worktree.branch}`);
    if (options.dryRun) return result;

    removeWorktree(root, worktree, { run });
    if (localBranch) {
      const deleted = git(run, root, ["branch", "-D", worktree.branch]);
      if (!deleted.ok) throw new Error(`git branch -D ${worktree.branch} failed: ${deleted.err}`);
    }
    if (remoteBranch) {
      const pushed = git(run, root, ["push", "--quiet", "origin", "--delete", worktree.branch]);
      if (!pushed.ok) throw new Error(`git push --delete ${worktree.branch} failed: ${pushed.err}`);
    }
    writeMarker(options.runDir, result);
  } catch (err) {
    result.warnings.push(`could not clean up ${target.id}: ${(err as Error).message.split("\n")[0]}`);
  }
  return result;
}

function writeMarker(runDir: string, result: CleanupResult): void {
  if (!existsSync(runDir)) return;
  writeFileSync(join(runDir, CLEANUP_MARKER), `${JSON.stringify({ at: new Date().toISOString(), removed: result.removed, kept: result.kept ?? null }, null, 2)}\n`);
}

/** One line for the output: what was removed, kept or went wrong. Empty when there was nothing to do. */
export function describeCleanup(runId: string, result: CleanupResult, dryRun = false): string[] {
  const lines: string[] = [];
  if (result.removed.length) lines.push(`${runId}: ${dryRun ? "would remove" : "removed"} ${result.removed.join(", ")}`);
  if (result.kept) lines.push(`${runId}: kept: ${result.kept}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

/** Store a cleanup's warnings and kept reason with the run, so `factory logs` shows them. */
export function recordCleanup(store: Store, target: Run, result: CleanupResult): void {
  for (const note of [...(result.kept ? [`kept: ${result.kept}`] : []), ...result.warnings]) {
    store.appendEvent(target.id, target.state, target.state, `cleanup: ${note}`);
  }
}

export interface SweepOptions {
  defaultBranch: string;
  /** The run folder of a run (`runDirOf`). */
  runDirOf: (runId: string) => string;
  run?: CommandRunner;
  dryRun?: boolean;
  now?: Date;
  /** Leave runs that finished this recently alone; defaults to CLEANUP_GRACE_MS. */
  graceMs?: number;
}

/**
 * Clean up the project's finished runs that still have a worktree or branch: those finished before
 * cleanup existed, by a worker that died, or whose PR was merged by hand. Returns the output lines.
 */
export function cleanupFinishedRuns(store: Store, project: Project, options: SweepOptions): string[] {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.graceMs ?? CLEANUP_GRACE_MS)).toISOString();
  const lines: string[] = [];
  for (const target of store.listRuns({ project_id: project.id })) {
    if (!isTerminal(target.state) || !target.worktree_path || target.updated_at > cutoff) continue;
    // A worker that still holds the lease is still stopping; it cleans up itself.
    if (target.lease_expires_at !== null && target.lease_expires_at > now.toISOString()) continue;
    const runDir = options.runDirOf(target.id);
    if (existsSync(join(runDir, CLEANUP_MARKER))) continue;
    const result = cleanupRun(target, { root: project.repo_path, runDir, defaultBranch: options.defaultBranch, run: options.run, dryRun: options.dryRun });
    if (!options.dryRun) recordCleanup(store, target, result);
    lines.push(...describeCleanup(target.id, result, options.dryRun));
  }
  return lines;
}
