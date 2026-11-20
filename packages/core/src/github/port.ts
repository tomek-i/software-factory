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

/** An issue as GitHub sees it now. */
export interface IssueState {
  number: number;
  state: "open" | "closed";
  /** Why it was closed, as GitHub words it (`completed`, `not_planned`, `duplicate`); only when closed. */
  reason?: string;
  /** The open PRs that link to it with a closing keyword (`Closes #n`), which may include the factory's own. */
  closedBy: number[];
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
  /** A comment's current body. */
  commentBody(commentId: number): string;
  /**
   * The issue's current body, only when the account the factory runs as wrote the issue; undefined
   * otherwise. The factory edits only its own issues' text (ticking acceptance criteria).
   */
  ownIssueBody(issueNumber: number): string | undefined;
  /** Replace an issue's body. */
  editIssueBody(issueNumber: number, body: string): void;
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
  /**
   * Whether the account the factory runs as already left a review on the PR whose body starts with
   * `marker`. Anyone can paste a marker into a review of their own, so only the factory's count.
   */
  hasReview(number: number, marker: string): boolean;
  /**
   * Leave a review with `event: COMMENT` on `commit` (the factory is the PR's author, so it can neither
   * approve nor request changes), with inline comments on the new side of the diff. GitHub refuses
   * the whole review (HTTP 422) when a comment's line is not in the diff.
   */
  createReview(number: number, review: PullRequestReview): void;
  pullRequestState(number: number): PullRequestState;
  issueState(number: number): IssueState;
  /**
   * Close a PR without merging, with a comment saying why, and delete its branch. A human decision
   * only (`cancelRun` of a run whose issue was closed on GitHub).
   */
  closePullRequest(number: number, comment: string): void;
  /** Take a draft PR out of draft. */
  markReady(number: number): void;
  /**
   * Merge with `method` (a merge commit by default), only if the PR's head is still `head` (the
   * commit that passed). A squash commit is titled after the PR, as `<title> (#<n>)`.
   */
  mergePullRequest(number: number, head: string, method?: MergeMethod): void;
  /** The status checks branch protection requires on the PR's head; empty when none are required. */
  requiredChecks(number: number): RequiredCheck[];
  /** Every status check on the PR's head, required or not, with its summary; empty when there are none. */
  pullRequestChecks(number: number): PullRequestCheck[];
  /** The PR's head commit and the size of its diff. */
  pullRequestDiff(number: number): PullRequestDiff;
  /**
   * The PR's unresolved review threads, outdated ones (their line changed since) included: GitHub's
   * rule that conversations be resolved before merging counts them too. Each comes with its first
   * comment and the bodies of the replies. Throws when the PR has more threads than one page holds,
   * rather than judge it on part of them.
   */
  unresolvedReviewThreads(number: number): ReviewThread[];
  /** Reply to a review thread, under its last comment. */
  replyToReviewThread(threadId: string, body: string): void;
  /** Mark a review thread resolved. */
  resolveReviewThread(threadId: string): void;
  /** Open an issue and return its number. */
  createIssue(issue: { title: string; body: string; labels?: string[] }): number;
  /**
   * Open code scanning alerts on the PR's head ref (`refs/pull/<n>/head`; its merge ref lists none in
   * practice). Empty when the repository has no code scanning.
   */
  codeScanningAlerts(number: number): CodeScanningAlert[];
  /**
   * Dismiss a code scanning alert. A human decision only (`dismissAlert` in the run service): no
   * agent or stage may call it.
   */
  dismissCodeScanningAlert(alert: number, reason: DismissReason, comment: string): void;
}

/** A review the factory leaves on a PR: a body and comments on lines of the change. */
export interface PullRequestReview {
  /** The head commit that was reviewed. */
  commit: string;
  body: string;
  /** `line` is a line of `path` on the new (RIGHT) side of the diff. */
  comments: { path: string; line: number; body: string }[];
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** The size of a PR's diff, at its head commit. */
export interface PullRequestDiff {
  head: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** GitHub's reasons for dismissing a code scanning alert. */
export const DISMISS_REASONS = ["false positive", "won't fix", "used in tests"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
/** GitHub refuses a longer dismissal comment. */
export const DISMISS_COMMENT_MAX = 280;

/** An open code scanning alert, as a human needs it to judge whether it is real. */
export interface CodeScanningAlert {
  number: number;
  /** The rule's id, e.g. `js/missing-rate-limiting`. */
  rule: string;
  /** The rule's short description, e.g. "Missing rate limiting". */
  description: string;
  /** The security severity when the rule has one (critical, high, ...), otherwise the rule's severity. */
  severity: string;
  /** The tool that raised it, e.g. `CodeQL`. */
  tool: string;
  file?: string;
  line?: number;
  /** The alert on GitHub. */
  url: string;
}

export interface RequiredCheck {
  name: string;
  /** gh's grouping of the check's state. */
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link?: string;
}

export interface PullRequestCheck extends RequiredCheck {
  /** What the check reported in a line, e.g. "2 new alerts including 2 high severity". */
  summary?: string;
}

/** An open review thread on a PR, as its first comment started it. Its text is untrusted data. */
export interface ReviewThread {
  /** GitHub's node id of the thread. */
  id: string;
  /** Who started it; a GitHub App as `<name>[bot]`, as the REST API and the web show it. */
  author: string;
  /** Started by the account the factory runs as, e.g. its own review notes. */
  own: boolean;
  path?: string;
  line?: number;
  body: string;
  /** The thread's first comment on GitHub. */
  url: string;
  /** Its line changed since the comment, so GitHub no longer shows it on the diff. */
  outdated: boolean;
  /** The bodies of the comments after the first, oldest first. */
  replies: string[];
}

export interface RepoLabel {
  name: string;
  description: string;
}

const CHECK_BUCKETS: readonly RequiredCheck["bucket"][] = ["pass", "fail", "pending", "skipping", "cancel"];

/**
 * What else `factory new` needs from GitHub to open the issues it drafted (`createIssue` is on
 * GithubPort, for the merge stage's follow-up issues). Kept apart so the pipeline's fakes need not
 * grow these methods. Faked in tests.
 */
export interface IssueWriterPort {
  createIssue(issue: { title: string; body: string; labels?: string[] }): number;
  /** The repository's labels, so the issue writer can pick from them. */
  listLabels(): RepoLabel[];
  /** Link `child` as a GitHub sub-issue of `parent`. */
  addSubIssue(parent: number, child: number): void;
}

const PR_REVIEWS = "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviews(last:100){nodes{body viewerDidAuthor}}}}}";
const REVIEW_THREADS =
  "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved isOutdated path line comments(first:20){nodes{author{__typename login} body url viewerDidAuthor}}}}}}}";
const REPLY_TO_THREAD = "mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}";
const RESOLVE_THREAD = "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}";
const OWN_ISSUE_BODY ="query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){body viewerDidAuthor}}}";

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
  /** `gh pr checks` with `flags`, read field by field; `description` becomes the check's summary. */
  const prChecks = (number: number, flags: string[]): PullRequestCheck[] => {
    // A commit with no checks at all, or none that are required, is an error to gh, not an empty list.
    // (Without --json gh also exits 1 for a failed check and 8 for a pending one, so stdout is read whatever the code.)
    const result = run("gh", ["pr", "checks", String(number), "-R", repo, ...flags], { cwd: project.repo_path });
    if (result.code !== 0 && /no (required )?checks reported/i.test(result.stderr)) return [];
    let checks: unknown;
    try {
      checks = JSON.parse(result.stdout);
      if (!Array.isArray(checks)) throw new Error("not a list");
    } catch {
      throw new GithubError(`gh pr checks failed: ${result.stderr.trim() || result.stdout.slice(0, 200) || "unknown error"}`);
    }
    return checks.map((c: { name?: unknown; bucket?: unknown; link?: unknown; description?: unknown }) => {
      if (typeof c.name !== "string" || !CHECK_BUCKETS.includes(c.bucket as RequiredCheck["bucket"])) {
        throw new GithubError(`gh pr checks returned unexpected output: ${JSON.stringify(c).slice(0, 200)}`);
      }
      return {
        name: c.name,
        bucket: c.bucket as RequiredCheck["bucket"],
        ...(typeof c.link === "string" && c.link ? { link: c.link } : {}),
        ...(typeof c.description === "string" && c.description.trim() ? { summary: c.description.trim() } : {}),
      };
    });
  };
  return {
    createIssue({ title, body, labels = [] }) {
      const labelArgs = labels.flatMap((label) => ["--label", label]);
      // gh prints the new issue's URL.
      const out = withBodyFile(body, (file) => gh(["issue", "create", "-R", repo, "--title", title, ...labelArgs, "--body-file", file]));
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
    listLabels() {
      const out = gh(["label", "list", "-R", repo, "--limit", "200", "--json", "name,description"]);
      let labels: unknown;
      try {
        labels = JSON.parse(out);
      } catch {
        labels = undefined;
      }
      const valid = (l: unknown): l is RepoLabel =>
        typeof l === "object" && l !== null && typeof (l as RepoLabel).name === "string" && typeof ((l as RepoLabel).description ?? "") === "string";
      if (!Array.isArray(labels) || !labels.every(valid)) {
        throw new GithubError(`gh label list returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      return labels.map((l) => ({ name: l.name, description: l.description ?? "" }));
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
    commentBody(commentId) {
      const out = gh(["api", `repos/${repo}/issues/comments/${commentId}`]);
      let body: unknown;
      try {
        body = (JSON.parse(out) as { body?: unknown }).body;
      } catch {
        throw new GithubError(`gh api returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      if (typeof body !== "string") throw new GithubError(`gh api returned no body for comment ${commentId}`);
      return body;
    },
    ownIssueBody(issueNumber) {
      const [owner, name] = repo.split("/");
      const out = gh(["api", "graphql", "-f", `query=${OWN_ISSUE_BODY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${issueNumber}`]);
      let issue: { body?: unknown; viewerDidAuthor?: unknown } | undefined;
      try {
        issue = (JSON.parse(out) as { data?: { repository?: { issue?: typeof issue } } }).data?.repository?.issue;
      } catch {
        throw new GithubError(`gh api graphql returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      if (typeof issue?.body !== "string") throw new GithubError(`gh api graphql returned no body for issue #${issueNumber}`);
      return issue.viewerDidAuthor === true ? issue.body : undefined;
    },
    editIssueBody(issueNumber, body) {
      withBodyFile(body, (file) => gh(["issue", "edit", String(issueNumber), "-R", repo, "--body-file", file]));
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
    issueState(number) {
      const out = gh(["issue", "view", String(number), "-R", repo, "--json", "number,state,stateReason,closedByPullRequestsReferences"]);
      let issue: { number?: unknown; state?: unknown; stateReason?: unknown; closedByPullRequestsReferences?: unknown };
      try {
        issue = JSON.parse(out) as typeof issue;
      } catch {
        throw new GithubError(`gh issue view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      const state = typeof issue.state === "string" ? issue.state.toLowerCase() : "";
      if (issue.number !== number || (state !== "open" && state !== "closed")) {
        throw new GithubError(`gh issue view returned unexpected output: ${out.slice(0, 200)}`);
      }
      const refs = Array.isArray(issue.closedByPullRequestsReferences) ? (issue.closedByPullRequestsReferences as { number?: unknown }[]) : [];
      const closedBy = refs.flatMap((r) => (typeof r?.number === "number" ? [r.number] : []));
      const reason = state === "closed" && typeof issue.stateReason === "string" && issue.stateReason ? issue.stateReason.toLowerCase() : undefined;
      return { number, state, ...(reason ? { reason } : {}), closedBy };
    },
    closePullRequest(number, comment) {
      gh(["pr", "close", String(number), "-R", repo, "--comment", comment, "--delete-branch"]);
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
      return prChecks(number, ["--required", "--json", "name,bucket,link"]);
    },
    pullRequestChecks(number) {
      return prChecks(number, ["--json", "name,bucket,link,description"]);
    },
    pullRequestDiff(number) {
      const out = gh(["pr", "view", String(number), "-R", repo, "--json", "headRefOid,additions,deletions,changedFiles"]);
      let pr: { headRefOid?: unknown; additions?: unknown; deletions?: unknown; changedFiles?: unknown };
      try {
        pr = JSON.parse(out) as typeof pr;
      } catch {
        throw new GithubError(`gh pr view returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
      if (typeof pr.headRefOid !== "string" || !pr.headRefOid || !count(pr.additions) || !count(pr.deletions) || !count(pr.changedFiles)) {
        throw new GithubError(`gh pr view returned unexpected output: ${out.slice(0, 200)}`);
      }
      return { head: pr.headRefOid, additions: pr.additions as number, deletions: pr.deletions as number, changedFiles: pr.changedFiles as number };
    },
    unresolvedReviewThreads(number) {
      const [owner, name] = repo.split("/");
      const out = gh(["api", "graphql", "-f", `query=${REVIEW_THREADS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${number}`]);
      let threads: { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | undefined;
      try {
        threads = (JSON.parse(out) as { data?: { repository?: { pullRequest?: { reviewThreads?: typeof threads } } } }).data?.repository?.pullRequest?.reviewThreads;
        if (!Array.isArray(threads?.nodes)) throw new Error("no threads");
      } catch {
        throw new GithubError(`gh api graphql returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      if (threads!.pageInfo?.hasNextPage === true) throw new GithubError(`PR #${number} has more than 100 review threads; resolve some on GitHub`);
      return (threads!.nodes as Record<string, unknown>[]).flatMap((t) => (t.isResolved === true ? [] : [parseThread(t)]));
    },
    replyToReviewThread(threadId, body) {
      // -f, not -F: a body starting with "@" must stay text rather than name a file to read.
      gh(["api", "graphql", "-f", `query=${REPLY_TO_THREAD}`, "-f", `t=${threadId}`, "-f", `b=${body}`]);
    },
    resolveReviewThread(threadId) {
      const out = gh(["api", "graphql", "-f", `query=${RESOLVE_THREAD}`, "-f", `t=${threadId}`]);
      let resolved: unknown;
      try {
        resolved = (JSON.parse(out) as { data?: { resolveReviewThread?: { thread?: { isResolved?: unknown } } } }).data?.resolveReviewThread?.thread?.isResolved;
      } catch {
        resolved = undefined;
      }
      if (resolved !== true) throw new GithubError(`gh api graphql did not resolve thread ${threadId}: ${out.slice(0, 200) || "(empty)"}`);
    },
    codeScanningAlerts(number) {
      const args = ["api", "-X", "GET", `repos/${repo}/code-scanning/alerts`, "-f", `ref=refs/pull/${number}/head`, "-f", "state=open", "-F", "per_page=100"];
      const result = run("gh", args, { cwd: project.repo_path });
      // A repository without code scanning answers 404 (or 403 without Advanced Security): it has no alerts.
      if (result.code !== 0 && /no analysis found|code scanning is not enabled|advanced security must be enabled/i.test(result.stderr + result.stdout)) return [];
      if (result.code !== 0) throw new GithubError(`gh api code-scanning/alerts failed: ${result.stderr.trim() || "unknown error"}`);
      let alerts: unknown;
      try {
        alerts = JSON.parse(result.stdout);
        if (!Array.isArray(alerts)) throw new Error("not a list");
      } catch {
        throw new GithubError(`gh api code-scanning/alerts returned unexpected output: ${result.stdout.slice(0, 200) || "(empty)"}`);
      }
      return alerts.map((a: Record<string, unknown>) => parseAlert(a));
    },
    dismissCodeScanningAlert(alert, reason, comment) {
      if (!Number.isInteger(alert) || alert <= 0) throw new GithubError(`${alert} is not an alert number`);
      if (!DISMISS_REASONS.includes(reason)) throw new GithubError(`"${reason}" is not a reason GitHub accepts`);
      // -f, never -F: a comment starting with @ must stay text, not name a file to upload.
      gh([
        "api",
        "-X",
        "PATCH",
        `repos/${repo}/code-scanning/alerts/${alert}`,
        "-f",
        "state=dismissed",
        "-f",
        `dismissed_reason=${reason}`,
        "-f",
        `dismissed_comment=${comment}`,
        "--silent",
      ]);
    },
    updatePullRequest(number, body) {
      withBodyFile(body, (file) => gh(["pr", "edit", String(number), "-R", repo, "--body-file", file]));
    },
    hasReview(number, marker) {
      const [owner, name] = repo.split("/");
      const out = gh(["api", "graphql", "-f", `query=${PR_REVIEWS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${number}`]);
      let reviews: { body?: unknown; viewerDidAuthor?: unknown }[];
      try {
        const parsed = JSON.parse(out) as { data?: { repository?: { pullRequest?: { reviews?: { nodes?: unknown } } } } };
        const nodes = parsed.data?.repository?.pullRequest?.reviews?.nodes;
        if (!Array.isArray(nodes)) throw new Error("no reviews");
        reviews = nodes as typeof reviews;
      } catch {
        throw new GithubError(`gh api graphql returned unexpected output: ${out.slice(0, 200) || "(empty)"}`);
      }
      return reviews.some((r) => r.viewerDidAuthor === true && typeof r.body === "string" && r.body.trimStart().startsWith(marker));
    },
    createReview(number, { commit, body, comments }) {
      const payload = {
        commit_id: commit,
        event: "COMMENT",
        body,
        comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
      };
      // From a file: the comments can exceed the Windows command-line limit.
      withBodyFile(JSON.stringify(payload), (file) => gh(["api", "-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", file, "--silent"]));
    },
  };
}

/** One review thread of GitHub's GraphQL API, checked field by field. */
function parseThread(t: Record<string, unknown>): ReviewThread {
  const comments = ((t.comments as { nodes?: unknown } | undefined)?.nodes as Record<string, unknown>[] | undefined) ?? [];
  const first = comments[0];
  const author = first?.author as { __typename?: unknown; login?: unknown } | null | undefined;
  if (typeof t.id !== "string" || !first || typeof first.body !== "string" || typeof first.url !== "string") {
    throw new GithubError(`gh api graphql returned an unexpected review thread: ${JSON.stringify(t).slice(0, 200)}`);
  }
  // GraphQL names an App without the "[bot]" the REST API, the web and `merge.comment_bots` use.
  // A deleted account has no author; "ghost" is how GitHub shows it.
  const login = typeof author?.login === "string" && author.login ? author.login : "ghost";
  const name = author?.__typename === "Bot" && !login.endsWith("[bot]") ? `${login}[bot]` : login;
  const line = t.line;
  return {
    id: t.id,
    author: name,
    own: first.viewerDidAuthor === true,
    ...(typeof t.path === "string" && t.path ? { path: t.path } : {}),
    ...(typeof line === "number" && Number.isInteger(line) && line > 0 ? { line } : {}),
    body: first.body,
    url: first.url,
    outdated: t.isOutdated === true,
    replies: comments.slice(1).flatMap((c) => (typeof c.body === "string" ? [c.body] : [])),
  };
}

/** One alert of GitHub's code scanning API, checked field by field. */
function parseAlert(a: Record<string, unknown>): CodeScanningAlert {
  const rule = (a.rule ?? {}) as Record<string, unknown>;
  const tool = (a.tool ?? {}) as Record<string, unknown>;
  const instance = (a.most_recent_instance ?? {}) as { location?: Record<string, unknown> };
  const location = instance.location ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const number = a.number;
  const url = str(a.html_url);
  if (typeof number !== "number" || !Number.isInteger(number) || !url || !str(rule.id) || !str(tool.name)) {
    throw new GithubError(`gh api code-scanning/alerts returned unexpected output: ${JSON.stringify(a).slice(0, 200)}`);
  }
  const line = location.start_line;
  return {
    number,
    rule: str(rule.id)!,
    description: str(rule.description) ?? str(rule.name) ?? str(rule.id)!,
    severity: str(rule.security_severity_level) ?? str(rule.severity) ?? "unknown",
    tool: str(tool.name)!,
    ...(str(location.path) ? { file: str(location.path) } : {}),
    ...(typeof line === "number" && Number.isInteger(line) && line > 0 ? { line } : {}),
    url,
  };
}
