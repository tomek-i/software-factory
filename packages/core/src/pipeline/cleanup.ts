import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminal } from "@factory/shared";
import { removeWorktree, type Worktree } from "../git/worktrees.js";
import type { Project, Run, Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";

/** In the run folder once a finished run's worktree and branches were dealt with; sweeps skip it. */
export const CLEANUP_MARKER = "cleanup.json";

/**
 * In the run folder while a removal that was judged safe is under way. A removal that fails half
 * way (a file locked on Windows) leaves a worktree with files missing, which would look like
 * uncommitted changes; with this marker the next attempt finishes the job instead of keeping it.
 */
export const CLEANUP_PENDING = "cleanup-pending.json";

/** Sweeps leave runs that finished this recently to the worker that finished them, which may still be stopping. */
export const CLEANUP_GRACE_MS = 2 * 60_000;

export interface CleanupResult {
  /** What was removed, for the output: "worktree", "local branch factory/12-x", "remote branch factory/12-x". */
  removed: string[];
  /** What was kept on purpose and why (work that is not on the remote, or not what was merged). */
  kept?: string;
  /** What went wrong; the next sweep tries again. */
  warnings: string[];
}

export interface CleanupOptions {
  /** The repository the run's worktree belongs to. */
  root: string;
  /** The run's folder (`.factory/runs/<run>`), where the markers go. */
  runDir: string;
  defaultBranch: string;
  /** For a done run: the PR head GitHub merged (see mergedHeadOf). Unknown means nothing is assumed merged. */
  mergedHead?: string;
  run?: CommandRunner;
  /** Say what would happen, change nothing. */
  dryRun?: boolean;
}

function git(run: CommandRunner, cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = run("git", args, { cwd });
  return { ok: result.code === 0, out: result.stdout.trim(), err: (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? "" };
}

/** The branch's commit on the remote, "" when the remote has no such branch. Throws when the remote cannot be asked. */
function remoteHead(run: CommandRunner, root: string, branch: string): string {
  const listed = git(run, root, ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (!listed.ok) throw new Error(`git ls-remote failed: ${listed.err}`);
  return listed.out.split(/\s+/)[0] ?? "";
}

/** Whether `commit` is `target` or in its history; false when either is unknown here. */
function within(run: CommandRunner, root: string, commit: string, target: string): boolean {
  return commit === target || (target !== "" && git(run, root, ["merge-base", "--is-ancestor", commit, target]).ok);
}

/**
 * Why removing the run's worktree and local branch would lose work, or undefined when it would not.
 * The branch is read from the repository, so a worktree removed by hand does not hide its commits.
 * - Uncommitted changes in the worktree always keep it.
 * - A done run's branch must be what GitHub merged (or part of it): a commit made after the merge stays.
 * - Any other run's branch must be on the remote, or have nothing beyond the default branch.
 */
function unsafeToRemove(root: string, worktree: Worktree, target: Run, options: CleanupOptions, run: CommandRunner): string | undefined {
  if (existsSync(worktree.path)) {
    const status = git(run, worktree.path, ["status", "--porcelain"]);
    if (!status.ok) throw new Error(`git status failed: ${status.err}`);
    if (status.out !== "") return "the worktree has uncommitted changes";
  }
  const local = git(run, root, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}^{commit}`]);
  if (!local.ok) return undefined; // no branch, nothing to lose
  if (target.state === "done" && options.mergedHead && within(run, root, local.out, options.mergedHead)) return undefined;
  const ahead = git(run, root, ["rev-list", "--count", `origin/${options.defaultBranch}..${local.out}`]);
  if (ahead.ok && ahead.out === "0") return undefined;
  if (within(run, root, local.out, remoteHead(run, root, worktree.branch))) return undefined;
  return target.state === "done" ? "the branch has commits that were not merged" : "the branch has commits that are not on the remote";
}

/**
 * Remove a finished run's worktree and branches, never its run folder.
 * - done (its PR was merged): the worktree and the local branch; the remote branch too, unless
 *   GitHub already deleted it or someone pushed to it after the merge.
 * - rejected, cancelled, failed: the worktree and the local branch; the remote branch stays, so a
 *   closed PR can be reopened.
 * Either way only when no work would be lost (see unsafeToRemove); otherwise both are kept and the
 * reason recorded. Never throws: a failure (a file locked on Windows, git refusing, the remote out
 * of reach) is a warning and leaves no marker, so the next sweep tries again.
 */
export function cleanupRun(target: Run, options: CleanupOptions): CleanupResult {
  const run = options.run ?? runCommand;
  const result: CleanupResult = { removed: [], warnings: [] };
  if (!isTerminal(target.state) || !target.worktree_path || !target.branch) return result;
  const worktree: Worktree = { path: target.worktree_path, branch: target.branch };
  const { root, runDir } = options;
  const pending = join(runDir, CLEANUP_PENDING);
  try {
    // Judged safe before and partly done: finish it.
    if (!existsSync(pending)) {
      const why = unsafeToRemove(root, worktree, target, options, run);
      if (why) {
        result.kept = `${why}, so the worktree and branch ${worktree.branch} are kept`;
        if (!options.dryRun) writeMarker(runDir, result, run, root, worktree.branch);
        return result;
      }
    }
    const localBranch = git(run, root, ["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`]).ok;
    let deleteRemote = false;
    if (target.state === "done") {
      const remote = remoteHead(run, root, worktree.branch);
      if (remote && options.mergedHead && remote === options.mergedHead) deleteRemote = true;
      else if (remote) result.kept = `the remote branch ${worktree.branch} is not what was merged, so it is kept`;
    }
    if (existsSync(worktree.path)) result.removed.push("worktree");
    if (localBranch) result.removed.push(`local branch ${worktree.branch}`);
    if (deleteRemote) result.removed.push(`remote branch ${worktree.branch}`);
    if (options.dryRun) return result;

    if (existsSync(runDir)) writeFileSync(pending, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
    removeWorktree(root, worktree, { run });
    if (localBranch) {
      const deleted = git(run, root, ["branch", "-D", worktree.branch]);
      if (!deleted.ok) throw new Error(`git branch -D ${worktree.branch} failed: ${deleted.err}`);
    }
    if (deleteRemote) {
      // Only while it still points at what was merged: a commit pushed meanwhile is never deleted.
      const pushed = git(run, root, ["push", "--quiet", `--force-with-lease=refs/heads/${worktree.branch}:${options.mergedHead}`, "origin", "--delete", worktree.branch]);
      if (!pushed.ok) throw new Error(`git push --delete ${worktree.branch} failed: ${pushed.err}`);
    }
    writeMarker(runDir, result, run, root, worktree.branch);
    rmSync(pending, { force: true });
  } catch (err) {
    result.warnings.push(`could not clean up ${target.id}: ${(err as Error).message.split(/\r?\n/)[0]}`);
  }
  return result;
}

function writeMarker(runDir: string, result: CleanupResult, run: CommandRunner, root: string, branch: string): void {
  if (!existsSync(runDir)) return;
  // For a run kept on purpose: the branch as it was, so `factory cleanup` can tell it may have changed.
  const head = result.kept ? git(run, root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).out || null : null;
  writeFileSync(join(runDir, CLEANUP_MARKER), `${JSON.stringify({ at: new Date().toISOString(), removed: result.removed, kept: result.kept ?? null, head }, null, 2)}\n`);
}

/** The PR head GitHub merged for a done run, from its events (a merge by the factory or by hand). */
export function mergedHeadOf(store: Store, runId: string): string | undefined {
  for (const event of [...store.listEvents(runId)].reverse()) {
    const data = event.data as { mergeCommit?: unknown; commit?: unknown } | null;
    if (data && typeof data.mergeCommit === "string" && typeof data.commit === "string") return data.commit;
  }
  return undefined;
}

/** One line for the output: what was removed, kept or went wrong. Empty when there was nothing to do. */
export function describeCleanup(runId: string, result: CleanupResult, dryRun = false): string[] {
  const lines: string[] = [];
  if (result.removed.length) lines.push(`${runId}: ${dryRun ? "would remove" : "removed"} ${result.removed.join(", ")}`);
  if (result.kept) lines.push(`${runId}: kept: ${result.kept}`);
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

/**
 * Store a cleanup's warnings and kept reason with the run, so `factory logs` shows them. The same
 * note twice in a row is stored once: a sweep retries a failing cleanup on every status.
 */
export function recordCleanup(store: Store, target: Run, result: CleanupResult): void {
  for (const note of [...(result.kept ? [`kept: ${result.kept}`] : []), ...result.warnings]) {
    const reason = `cleanup: ${note}`;
    if (store.listEvents(target.id).at(-1)?.reason === reason) continue;
    store.appendEvent(target.id, target.state, target.state, reason);
  }
}

/** Clean up one finished run with what the store knows about it, and record the outcome. */
export function cleanupFinishedRun(store: Store, target: Run, options: Omit<CleanupOptions, "mergedHead">): CleanupResult {
  const result = cleanupRun(target, { ...options, mergedHead: target.state === "done" ? mergedHeadOf(store, target.id) : undefined });
  if (!options.dryRun) recordCleanup(store, target, result);
  return result;
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
  /** Look again at runs kept on purpose, e.g. after their commits were pushed (`factory cleanup`). */
  recheckKept?: boolean;
}

function keptOnPurpose(runDir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(runDir, CLEANUP_MARKER), "utf8")) as { kept?: unknown }).kept != null;
  } catch {
    return false;
  }
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
    const runDir = options.runDirOf(target.id);
    if (existsSync(join(runDir, CLEANUP_MARKER)) && !(options.recheckKept && keptOnPurpose(runDir))) continue;
    const result = cleanupFinishedRun(store, target, { root: project.repo_path, runDir, defaultBranch: options.defaultBranch, run: options.run, dryRun: options.dryRun });
    lines.push(...describeCleanup(target.id, result, options.dryRun));
  }
  return lines;
}
