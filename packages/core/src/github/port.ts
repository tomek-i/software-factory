import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { GithubError } from "./issues.js";

/** A pull request as GitHub sees it now. */
export interface PullRequestState {
  number: number;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** The commit at the head of the PR branch. */
  head: string;
  /** Set once the PR is merged. */
  mergeCommit?: string;
}

/** What the pipeline needs from GitHub. Faked in tests. */
export interface GithubPort {
  commentOnIssue(issueNumber: number, body: string): void;
  /**
   * The id of the latest comment on the issue that starts with `marker` and was written by the
   * account the factory runs as. Anyone can paste a marker into a comment of their own, so only the
   * factory's own comments count.
   */
  findComment(issueNumber: number, marker: string): number | undefined;
  /** Replace a comment's body. */
  editComment(commentId: number, body: string): void;
  /** The open pull request whose head is this branch, if any. */
  findPullRequest(branch: string): number | undefined;
  /** Open pull requests whose head branch starts with `prefix`, e.g. `factory/lessons-`. */
  findOpenPullRequests(prefix: string): { number: number; head: string }[];
  /** Open a draft PR and return its number. */
  createDraftPullRequest(pr: { head: string; base: string; title: string; body: string }): number;
  /** Open a PR that is ready for review (not a draft) and return its number. */
  createPullRequest(pr: { head: string; base: string; title: string; body: string }): number;
  /** Replace a PR's description. */
  updatePullRequest(number: number, body: string): void;
  pullRequestState(number: number): PullRequestState;
  /** Take a draft PR out of draft. */
  markReady(number: number): void;
  /**
   * Merge with `method` (a merge commit by default), only if the PR's head is still `head` (the
   * commit that passed). A squash commit is titled after the PR, as `<title> (#<n>)`.
   */
  mergePullRequest(number: number, head: string, method?: MergeMethod): void;
  /** The status checks branch protection requires on the PR's head; empty when none are required. */
  requiredChecks(number: number): RequiredCheck[];
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface RequiredCheck {
  name: string;
  /** gh's grouping of the check's state. */
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link?: string;
}

const CHECK_BUCKETS: readonly RequiredCheck["bucket"][] = ["pass", "fail", "pending", "skipping", "cancel"];

/**
 * What `factory new` needs from GitHub to open the issues it drafted. Kept apart from GithubPort:
 * the pipeline never creates issues, so its fakes need not grow these methods. Faked in tests.
 */
export interface IssueWriterPort {
  /** Open an issue and return its number. */
  createIssue(issue: { title: string; body: string }): number;
  /** Link `child` as a GitHub sub-issue of `parent`. */
  addSubIssue(parent: number, child: number): void;
}

const ADD_SUB_ISSUE = "mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}";

/** Hidden marker on every comment the factory posts, so later stages can find (and not duplicate) them. */
export function factoryComment(runId: string, kind: string, body: string): string {
  return `<!-- factory:${runId}:${kind} -->\n${body.trim()}\n`;
}

export function ghPort(project: Project, run: CommandRunner = runCommand): GithubPort & IssueWriterPort {
  const repo = project.github_repo;
  if (!repo) throw new GithubError(`project ${project.name} has no GitHub repository`);
  const gh = (args: string[]) => {
    const result = run("gh", args, { cwd: project.repo_path });
    if (result.code !== 0) throw new GithubError(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr || "unknown error"}`);
    return result.stdout;
  };
  // From a file: a long text can exceed the Windows command-line limit (~32k characters).
  const withBodyFile = <T>(body: string, fn: (file: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "factory-body-"));
    try {
      const file = join(dir, "body.md");
      writeFileSync(file, body);
      return fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  /** The GraphQL node id of an issue, which the sub-issue mutation needs instead of its number. */
  const nodeId = (number: number): string => {
    const out = gh(["issue", "view", String(number), "-R", repo, "--json", "id"]);
    let issue: { id?: unknown };
    try {
      issue = JSON.parse(out) as typeof issue;
    } catch {
      throw new GithubError(`gh issue view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
    }
    if (typeof issue.id !== "string" || !issue.id) throw new GithubError(`gh issue view returned no id for #${number}`);
    return issue.id;
  };
  return {
    createIssue({ title, body }) {
      // gh prints the new issue's URL.
      const out = withBodyFile(body, (file) => gh(["issue", "create", "-R", repo, "--title", title, "--body-file", file]));
      const match = /\/issues\/(\d+)/.exec(out);
      if (!match) {
        // gh succeeded, so the issue probably exists; only its number is unknown.
        throw new GithubError(
          `gh issue create returned unexpected output: ${out.slice(0, 200) || "(empty)"}. The issue "${title}" may have been created anyway; check GitHub before trying again.`,
        );
      }
      return Number(match[1]);
    },
    addSubIssue(parent, child) {
      gh(["api", "graphql", "-f", `query=${ADD_SUB_ISSUE}`, "-f", `p=${nodeId(parent)}`, "-f", `c=${nodeId(child)}`]);
    },
    commentOnIssue(issueNumber, body) {
      gh(["issue", "comment", String(issueNumber), "-R", repo, "--body", body]);
    },
    findComment(issueNumber, marker) {
      const out = gh(["issue", "view", String(issueNumber), "-R", repo, "--json", "comments"]);
      let comments: { body?: unknown; url?: unknown; viewerDidAuthor?: unknown }[];
      try {
        const parsed = JSON.parse(out) as { comments?: unknown };
        if (!Array.isArray(parsed.comments)) throw new Error("no comments");
        comments = parsed.comments as typeof comments;
      } catch {
        throw new GithubError(`gh issue view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      const mine = comments.filter((c) => c.viewerDidAuthor === true && typeof c.body === "string" && c.body.trimStart().startsWith(marker));
      const url = mine.at(-1)?.url;
      if (url === undefined) return undefined;
      // gh only gives the GraphQL node id; the REST id the edit needs is in the comment's URL.
      const id = typeof url === "string" ? /#issuecomment-(\d+)$/.exec(url)?.[1] : undefined;
      if (!id) throw new GithubError(`gh issue view returned a comment without its id: ${String(url).slice(0, 200)}`);
      return Number(id);
    },
    editComment(commentId, body) {
      // From a file, like a PR description: a long comment can exceed the Windows command-line limit.
      const dir = mkdtempSync(join(tmpdir(), "factory-comment-"));
      try {
        const file = join(dir, "body.md");
        writeFileSync(file, body);
        gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-F", `body=@${file}`, "--silent"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    findPullRequest(branch) {
      const out = gh(["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "number", "--limit", "1"]);
      let prs: { number: number }[];
      try {
        prs = JSON.parse(out) as { number: number }[];
      } catch {
        throw new GithubError(`gh pr list returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      return prs[0]?.number;
    },
    findOpenPullRequests(prefix) {
      // `--head` only matches a whole branch name, so the prefix is matched here.
      const out = gh(["pr", "list", "-R", repo, "--state", "open", "--json", "number,headRefName", "--limit", "200"]);
      let prs: { number?: unknown; headRefName?: unknown }[];
      try {
        prs = JSON.parse(out) as typeof prs;
        if (!Array.isArray(prs)) throw new Error("not a list");
      } catch {
        throw new GithubError(`gh pr list returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      return prs.flatMap((pr) =>
        typeof pr.number === "number" && typeof pr.headRefName === "string" && pr.headRefName.startsWith(prefix) ? [{ number: pr.number, head: pr.headRefName }] : [],
      );
    },
    createDraftPullRequest({ head, base, title, body }) {
      // gh prints the new PR's URL.
      const out = gh(["pr", "create", "-R", repo, "--draft", "--head", head, "--base", base, "--title", title, "--body", body]);
      const match = /\/pull\/(\d+)/.exec(out);
      if (!match) throw new GithubError(`gh pr create returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      return Number(match[1]);
    },
    createPullRequest({ head, base, title, body }) {
      const out = withBodyFile(body, (file) => gh(["pr", "create", "-R", repo, "--head", head, "--base", base, "--title", title, "--body-file", file]));
      const match = /\/pull\/(\d+)/.exec(out);
      if (!match) throw new GithubError(`gh pr create returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      return Number(match[1]);
    },
    pullRequestState(number) {
      const out = gh(["pr", "view", String(number), "-R", repo, "--json", "number,state,isDraft,headRefOid,mergeCommit"]);
      let pr: { number?: unknown; state?: unknown; isDraft?: unknown; headRefOid?: unknown; mergeCommit?: { oid?: unknown } | null };
      try {
        pr = JSON.parse(out) as typeof pr;
      } catch {
        throw new GithubError(`gh pr view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      const state = typeof pr.state === "string" ? pr.state.toLowerCase() : "";
      if (pr.number !== number || (state !== "open" && state !== "merged" && state !== "closed") || typeof pr.headRefOid !== "string") {
        throw new GithubError(`gh pr view returned unexpected output: ${out.slice(0, 200)}`);
      }
      const mergeCommit = typeof pr.mergeCommit?.oid === "string" ? pr.mergeCommit.oid : undefined;
      return { number, state, draft: pr.isDraft === true, head: pr.headRefOid, ...(mergeCommit ? { mergeCommit } : {}) };
    },
    markReady(number) {
      gh(["pr", "ready", String(number), "-R", repo]);
    },
    mergePullRequest(number, head, method = "merge") {
      const args = ["pr", "merge", String(number), "-R", repo, `--${method}`, "--match-head-commit", head];
      if (method === "squash") {
        // The PR title, so a conventional-commit title becomes the commit on the default branch.
        const out = gh(["pr", "view", String(number), "-R", repo, "--json", "title"]);
        let title: unknown;
        try {
          title = (JSON.parse(out) as { title?: unknown }).title;
        } catch {
          throw new GithubError(`gh pr view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
        }
        if (typeof title !== "string" || !title.trim()) throw new GithubError(`gh pr view returned no title for #${number}`);
        args.push("--subject", `${title.trim()} (#${number})`);
      }
      gh(args);
    },
    requiredChecks(number) {
      const args = ["pr", "checks", String(number), "-R", repo, "--required", "--json", "name,bucket,link"];
      // A commit with no checks at all, or none that are required, is an error to gh, not an empty list.
      // (Without --json gh also exits 1 for a failed check and 8 for a pending one, so stdout is read whatever the code.)
      const result = run("gh", args, { cwd: project.repo_path });
      if (result.code !== 0 && /no (required )?checks reported/i.test(result.stderr)) return [];
      let checks: unknown;
      try {
        checks = JSON.parse(result.stdout);
        if (!Array.isArray(checks)) throw new Error("not a list");
      } catch {
        throw new GithubError(`gh pr checks failed: ${result.stderr.trim() || result.stdout.slice(0, 200) || "unknown error"}`);
      }
      return checks.map((c: { name?: unknown; bucket?: unknown; link?: unknown }) => {
        if (typeof c.name !== "string" || !CHECK_BUCKETS.includes(c.bucket as RequiredCheck["bucket"])) {
          throw new GithubError(`gh pr checks returned unexpected output: ${JSON.stringify(c).slice(0, 200)}`);
        }
        return { name: c.name, bucket: c.bucket as RequiredCheck["bucket"], ...(typeof c.link === "string" && c.link ? { link: c.link } : {}) };
      });
    },
    updatePullRequest(number, body) {
      withBodyFile(body, (file) => gh(["pr", "edit", String(number), "-R", repo, "--body-file", file]));
    },
  };
}
