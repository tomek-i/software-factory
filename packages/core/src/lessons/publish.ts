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

/** `factory/lessons-<UTC yyyymmdd-hhmmss>`. */
export function lessonsBranch(now: Date): string {
  return `factory/lessons-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
}

export interface PublishLessonsOptions {
  root: string;
  defaultBranch: string;
  lessons: ApprovedLesson[];
  github: GithubPort;
  run?: CommandRunner;
  now?: Date;
}

/**
 * Append approved lessons to `.factory/lessons.md` through a pull request opened by the engine:
 * a branch from the freshly fetched default branch, in a temporary worktree that is removed
 * afterwards, so the user's working copy is never touched. The lessons take effect once a human
 * merges the PR, because agents read lessons from the default branch.
 */
export function publishLessons(options: PublishLessonsOptions): { branch: string; number: number } {
  const run = options.run ?? runCommand;
  const { root, defaultBranch, lessons } = options;
  if (lessons.length === 0) throw new Error("no lessons to publish");
  const git = (args: string[], cwd = root) => {
    const result = run("git", args, { cwd });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout || "unknown error"}`);
    return result.stdout;
  };
  const branch = lessonsBranch(options.now ?? new Date());
  git(["fetch", "--quiet", "origin", defaultBranch]);
  const dir = mkdtempSync(join(tmpdir(), "factory-lessons-"));
  const worktree = join(dir, "worktree");
  // Detached: no local branch is left behind; the commit only goes to the remote branch.
  git(["worktree", "add", "--quiet", "--detach", worktree, `origin/${defaultBranch}`]);
  try {
    const file = join(worktree, LESSONS_FILE);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, appendLessons(existsSync(file) ? readFileSync(file, "utf8") : undefined, lessons.map((l) => l.rule)));
    git(["add", LESSONS_FILE], worktree);
    git(["commit", "--quiet", "-m", `chore(factory): add ${lessons.length === 1 ? "an approved lesson" : `${lessons.length} approved lessons`}`], worktree);
    git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], worktree);
  } finally {
    // Best effort: a failure here must not hide the error that got us here.
    run("git", ["worktree", "remove", "--force", worktree], { cwd: root });
    rmSync(dir, { recursive: true, force: true });
    run("git", ["worktree", "prune"], { cwd: root });
  }
  const number = options.github.createPullRequest({
    head: branch,
    base: defaultBranch,
    title: lessons.length === 1 ? "chore(factory): add an approved lesson" : `chore(factory): add ${lessons.length} approved lessons`,
    body: lessonsPrBody(lessons, defaultBranch),
  });
  return { branch, number };
}
