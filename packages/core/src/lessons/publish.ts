import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GithubPort } from "../github/port.js";
import type { StoredLesson } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";

/** Read by every agent from the default branch (see trustedReader). */
export const LESSONS_FILE = ".factory/lessons.md";

const HEADER = "# Lessons\n\nApproved lessons from past runs. Agents read this file before they start.\n";

/** An approved lesson with where it came from, for the PR description. */
export type ApprovedLesson = Pick<StoredLesson, "id" | "run_id" | "rule" | "observation" | "evidence"> & { issue_number?: number | null };

/**
 * `.factory/lessons.md` with each rule appended as a `- ` line. Keeps the file's own line endings,
 * and starts a fresh file with the header `factory init` writes.
 */
export function appendLessons(text: string | undefined, rules: string[]): string {
  const current = text ?? HEADER;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  while (lines.length && lines.at(-1)!.trim() === "") lines.pop();
  // A blank line between the intro text and the list, but none inside the list.
  if (lines.length && !/^[-*]\s/.test(lines.at(-1)!)) lines.push("");
  return [...lines, ...rules.map((rule) => `- ${rule.trim()}`), ""].join(eol);
}

/** The lessons PR's description: each rule, the run it came from, and why. */
export function lessonsPrBody(lessons: ApprovedLesson[], defaultBranch: string): string {
  const items = lessons.map((l) =>
    [
      `- **${l.rule}**`,
      `  From run \`${l.run_id}\`${l.issue_number ? ` (#${l.issue_number})` : ""}, lesson ${l.id}: ${l.observation.replace(/\s+/g, " ").trim()}`,
      `  Evidence: ${l.evidence.replace(/\s+/g, " ").trim()}`,
    ].join("\n"),
  );
  return [
    `Adds ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} approved with \`factory lessons approve\` to \`${LESSONS_FILE}\`.`,
    `Agents read that file from \`${defaultBranch}\`, so the lessons apply to runs that start after this PR is merged.`,
    "",
    ...items,
    "",
  ].join("\n");
}

/** Branches of the engine's lessons PRs start with this. */
export const LESSONS_BRANCH_PREFIX = "factory/lessons-";

/** `factory/lessons-<UTC yyyymmdd-hhmmss-mmm>`: milliseconds, so two approvals in one second differ. */
export function lessonsBranch(now: Date): string {
  const iso = now.toISOString(); // 2026-11-12T09:05:07.123Z
  return `${LESSONS_BRANCH_PREFIX}${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${iso.slice(20, 23)}`;
}

/** Each git command here may run the repo's hooks; none may hang the CLI. */
const GIT_TIMEOUT_MS = 5 * 60_000;

export interface PublishLessonsOptions {
  root: string;
  defaultBranch: string;
  lessons: ApprovedLesson[];
  github: GithubPort;
  /**
   * The lessons already in an open lessons PR, so its description can list them all after more are
   * added. Lessons approved from another clone are not known here; the file on the branch still has them.
   */
  inPullRequest?: (number: number) => ApprovedLesson[];
  run?: CommandRunner;
  now?: Date;
}

export interface PublishedLessons {
  branch: string;
  number: number;
  /** True when the lessons were added to a lessons PR that was already open. */
  addedToOpen: boolean;
  /** Something that went wrong after the lessons were pushed. */
  warning?: string;
}

/**
 * Append approved lessons to `.factory/lessons.md` through a pull request made by the engine, in a
 * temporary worktree that is removed afterwards, so the user's working copy is never touched. When a
 * lessons PR is still open, the lessons go onto its branch and its description is updated: two PRs
 * that both append to the end of the file would conflict. Otherwise a new branch is made from the
 * freshly fetched default branch. The lessons take effect once a human merges the PR, because
 * agents read lessons from the default branch.
 *
 * The commit runs the repository's own hooks and signing; they are never skipped. If one refuses,
 * nothing is pushed and the error says so.
 */
export function publishLessons(options: PublishLessonsOptions): PublishedLessons {
  const run = options.run ?? runCommand;
  const { root, defaultBranch, lessons, github } = options;
  if (lessons.length === 0) throw new Error("no lessons to publish");
  const git = (args: string[], cwd = root) => {
    const result = run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout || "unknown error"}`);
    return result.stdout;
  };

  const open = github.findOpenPullRequests(LESSONS_BRANCH_PREFIX)[0];
  const branch = open?.head ?? lessonsBranch(options.now ?? new Date());
  const base = open ? branch : defaultBranch;
  git(["fetch", "--quiet", "origin", base]);
  const dir = mkdtempSync(join(tmpdir(), "factory-lessons-"));
  const worktree = join(dir, "worktree");
  let added = false;
  try {
    // Detached: no local branch is left behind; the commit only goes to the remote branch.
    git(["worktree", "add", "--quiet", "--detach", worktree, `origin/${base}`]);
    added = true;
    const file = join(worktree, LESSONS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, appendLessons(existsSync(file) ? readFileSync(file, "utf8") : undefined, lessons.map((l) => l.rule)));
    git(["add", LESSONS_FILE], worktree);
    try {
      git(["commit", "--quiet", "-m", `chore(factory): add ${lessons.length === 1 ? "an approved lesson" : `${lessons.length} approved lessons`}`], worktree);
    } catch (err) {
      throw new Error(
        `a commit hook or commit signing in this repository refused the lessons commit (they are never skipped), so nothing was pushed: ${(err as Error).message}`,
      );
    }
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], worktree);
  } finally {
    // Best effort: cleaning up must neither hide the error that got us here nor stop a pushed commit's PR.
    if (added) run("git", ["worktree", "remove", "--force", worktree], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp folder is harmless; the OS cleans its temp directory.
    }
    run("git", ["worktree", "prune"], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
  }

  if (open) {
    const all = [...(options.inPullRequest?.(open.number) ?? []), ...lessons];
    try {
      github.updatePullRequest(open.number, lessonsPrBody(all, defaultBranch));
    } catch (err) {
      // The lessons are on the PR's branch already, so they count as approved; only the description lags.
      return { branch, number: open.number, addedToOpen: true, warning: `could not update the description of PR #${open.number}: ${(err as Error).message}` };
    }
    return { branch, number: open.number, addedToOpen: true };
  }
  try {
    const number = github.createPullRequest({
      head: branch,
      base: defaultBranch,
      title: lessons.length === 1 ? "chore(factory): add an approved lesson" : `chore(factory): add ${lessons.length} approved lessons`,
      body: lessonsPrBody(lessons, defaultBranch),
    });
    return { branch, number, addedToOpen: false };
  } catch (err) {
    // Without a PR the branch is only clutter, and the lessons stay proposed to be approved again.
    run("git", ["push", "--quiet", "origin", "--delete", branch], { cwd: root, timeoutMs: GIT_TIMEOUT_MS });
    throw err;
  }
}
