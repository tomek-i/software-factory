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
  /** The open pull request whose head is this branch, if any. */
  findPullRequest(branch: string): number | undefined;
  /** Open a draft PR and return its number. */
  createDraftPullRequest(pr: { head: string; base: string; title: string; body: string }): number;
  /** Replace a PR's description. */
  updatePullRequest(number: number, body: string): void;
  pullRequestState(number: number): PullRequestState;
}

/** Hidden marker on every comment the factory posts, so later stages can find (and not duplicate) them. */
export function factoryComment(runId: string, kind: string, body: string): string {
  return `<!-- factory:${runId}:${kind} -->\n${body.trim()}\n`;
}

export function ghPort(project: Project, run: CommandRunner = runCommand): GithubPort {
  const repo = project.github_repo;
  if (!repo) throw new GithubError(`project ${project.name} has no GitHub repository`);
  const gh = (args: string[]) => {
    const result = run("gh", args, { cwd: project.repo_path });
    if (result.code !== 0) throw new GithubError(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr || "unknown error"}`);
    return result.stdout;
  };
  return {
    commentOnIssue(issueNumber, body) {
      gh(["issue", "comment", String(issueNumber), "-R", repo, "--body", body]);
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
    createDraftPullRequest({ head, base, title, body }) {
      // gh prints the new PR's URL.
      const out = gh(["pr", "create", "-R", repo, "--draft", "--head", head, "--base", base, "--title", title, "--body", body]);
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
    updatePullRequest(number, body) {
      // From a file: a long description can exceed the Windows command-line limit (~32k characters).
      const dir = mkdtempSync(join(tmpdir(), "factory-pr-"));
      try {
        const file = join(dir, "body.md");
        writeFileSync(file, body);
        gh(["pr", "edit", String(number), "-R", repo, "--body-file", file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
