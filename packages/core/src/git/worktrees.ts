import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand, type CommandRunner } from "../util/exec.js";

export const WORKTREES_DIR = ".worktrees";

export class GitError extends Error {}

function git(run: CommandRunner, cwd: string, args: string[]): string {
  const result = run("git", args, { cwd });
  if (result.code !== 0) throw new GitError(`git ${args[0]} failed: ${result.stderr || result.stdout || "unknown error"}`);
  return result.stdout;
}

/** A branch-safe slug: ascii letters, digits and single dashes, at most `max` characters. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return slug || "work";
}

export function branchName(issueNumber: number | null, title: string): string {
  return `factory/${issueNumber ?? "new"}-${slugify(title)}`;
}

function branchExists(run: CommandRunner, root: string, branch: string): boolean {
  const local = run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: root }).code === 0;
  const remote = run("git", ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], { cwd: root }).code === 0;
  return local || remote;
}

export interface Worktree {
  path: string;
  branch: string;
}

export interface CreateWorktreeOptions {
  root: string;
  runId: string;
  /** Preferred branch name. A numeric suffix is added if an earlier run already used it. */
  branch: string;
  defaultBranch: string;
  run?: CommandRunner;
}

/**
 * Create `.worktrees/<run-id>` on a new branch from the freshly fetched remote default branch,
 * so the run starts from what is actually merged rather than the user's local checkout.
 */
export function createWorktree(options: CreateWorktreeOptions): Worktree {
  const run = options.run ?? runCommand;
  const { root } = options;
  const path = join(root, WORKTREES_DIR, options.runId);
  if (existsSync(path)) throw new GitError(`worktree ${path} already exists`);

  git(run, root, ["fetch", "--quiet", "origin", options.defaultBranch]);

  // Never reuse (or reset) a branch an earlier run left behind: it may hold work or an open PR.
  let branch = options.branch;
  for (let n = 2; branchExists(run, root, branch); n++) branch = `${options.branch}-${n}`;

  // core.longpaths: worktrees nest one level deeper than the repo, which pushes some
  // node_modules paths past Windows' 260-character limit.
  git(run, root, [
    "-c",
    "core.longpaths=true",
    "worktree",
    "add",
    "--quiet",
    "--no-track",
    "-b",
    branch,
    path,
    `origin/${options.defaultBranch}`,
  ]);
  git(run, path, ["config", "core.longpaths", "true"]);
  return { path, branch };
}

/** Remove a run's worktree. The branch is kept unless asked for, since it may back an open PR. */
export function removeWorktree(
  root: string,
  worktree: Worktree,
  options: { deleteBranch?: boolean; run?: CommandRunner } = {},
): void {
  const run = options.run ?? runCommand;
  if (existsSync(worktree.path)) git(run, root, ["worktree", "remove", "--force", worktree.path]);
  git(run, root, ["worktree", "prune"]);
  if (options.deleteBranch) git(run, root, ["branch", "-D", worktree.branch]);
}

/** The git facts the state machine's guards need, read from a run's worktree. */
export interface GitEvidence {
  head(): string;
  isClean(): boolean;
  commitsAhead(): number;
  isPushed(): boolean;
}

export function gitEvidence(
  worktree: Worktree,
  defaultBranch: string,
  run: CommandRunner = runCommand,
): GitEvidence {
  const at = (args: string[]) => git(run, worktree.path, args);
  return {
    head: () => at(["rev-parse", "HEAD"]),
    isClean: () => at(["status", "--porcelain"]) === "",
    commitsAhead: () => Number(at(["rev-list", "--count", `origin/${defaultBranch}..HEAD`])),
    // Ask the remote itself: a local tracking ref can be stale or point at a different remote.
    isPushed: () => {
      const line = at(["ls-remote", "origin", `refs/heads/${worktree.branch}`]);
      return line !== "" && line.split(/\s+/)[0] === at(["rev-parse", "HEAD"]);
    },
  };
}
