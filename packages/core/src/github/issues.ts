import type { IssueInput, Project, Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";

const FIELDS = "number,title,body,state,author,labels,url,updatedAt";

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: { login: string } | null;
  labels: { name: string }[];
  url: string;
  updatedAt: string;
}

export class GithubError extends Error {}

function toInput(issue: GhIssue): IssueInput {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state.toLowerCase() === "open" ? "open" : "closed",
    // Deleted accounts come back as null.
    author: issue.author?.login ?? "ghost",
    labels: issue.labels.map((l) => l.name),
    url: issue.url,
    gh_updated_at: issue.updatedAt,
  };
}

function gh<T>(args: string[], cwd: string, run: CommandRunner): T {
  const command = `gh ${args.slice(0, 2).join(" ")}`;
  const result = run("gh", args, { cwd });
  if (result.code !== 0) throw new GithubError(`${command} failed: ${result.stderr || "unknown error"}`);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new GithubError(`${command} returned unexpected output: ${result.stdout.slice(0, 200) || "(empty)"}`);
  }
}

function requireRepo(project: Project): string {
  if (!project.github_repo) throw new GithubError(`project ${project.name} has no GitHub repository`);
  return project.github_repo;
}

export interface SyncResult {
  open: number;
  closed: number;
}

/**
 * Mirror the repository's open issues into the local store. Issues that are no longer
 * open on GitHub are marked closed and removed from the queue. Labels are stored for
 * display only; they never queue anything.
 */
export function syncIssues(store: Store, project: Project, run: CommandRunner = runCommand, limit = 500): SyncResult {
  const repo = requireRepo(project);
  const syncStartedAt = new Date().toISOString();
  const issues = gh<GhIssue[]>(
    ["issue", "list", "-R", repo, "--state", "open", "--limit", String(limit), "--json", FIELDS],
    project.repo_path,
    run,
  );
  if (issues.length >= limit) {
    // A truncated list would wrongly close every issue past the limit.
    throw new GithubError(`more than ${limit} open issues; raise the sync limit`);
  }
  return store.transaction(() => {
    for (const issue of issues) store.upsertIssue(project.id, toInput(issue));
    const closed = store.closeIssuesExcept(
      project.id,
      issues.map((i) => i.number),
      syncStartedAt,
    );
    return { open: issues.length, closed };
  });
}

/** Fetch a single issue (open or closed) and store it, e.g. when queueing an issue that was never synced. */
export function fetchIssue(store: Store, project: Project, number: number, run: CommandRunner = runCommand): void {
  const repo = requireRepo(project);
  const issue = gh<GhIssue>(["issue", "view", String(number), "-R", repo, "--json", FIELDS], project.repo_path, run);
  // `gh issue view` happily returns pull requests too; a PR description is not an issue to build from.
  if (/\/pull\/\d+/.test(issue.url)) throw new GithubError(`#${number} is a pull request, not an issue`);
  // A transferred issue can resolve to a different number; don't silently store the wrong one.
  if (issue.number !== number) throw new GithubError(`#${number} resolved to #${issue.number}`);
  store.upsertIssue(project.id, toInput(issue));
}
