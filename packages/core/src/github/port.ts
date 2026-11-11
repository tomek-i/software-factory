import type { Project } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { GithubError } from "./issues.js";

/** What the pipeline needs from GitHub. Faked in tests. */
export interface GithubPort {
  commentOnIssue(issueNumber: number, body: string): void;
  /** The open pull request whose head is this branch, if any. */
  findPullRequest(branch: string): number | undefined;
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
  };
}
