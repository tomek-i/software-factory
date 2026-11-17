import { runCommand, type CommandRunner } from "./exec.js";

/** Absolute path of the repository containing cwd, or undefined when cwd is not in a git repo. */
export function findRepoRoot(cwd: string, run: CommandRunner = runCommand): string | undefined {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.code === 0 ? result.stdout : undefined;
}

/** Turn a GitHub remote URL (https or ssh) into "owner/repo". */
export function parseGithubRemote(url: string): string | undefined {
  // String handling rather than one unanchored regex, which backtracked polynomially on long input.
  // What it matches, `github.com` + `:` or `/` + owner/repo[.git][/] at the end, holds no
  // whitespace, so only the last word can hold it.
  const word = url.trim().split(/\s/).pop() ?? "";
  const path = word.endsWith("/") ? word.slice(0, -1) : word;
  const slash = path.lastIndexOf("/");
  let repo = path.slice(slash + 1);
  if (slash < 0 || !repo) return undefined;
  if (repo.endsWith(".git") && repo.length > ".git".length) repo = repo.slice(0, -".git".length);
  const head = path.slice(0, slash);
  // The owner holds no `/`, so `github.com` is in the head's last segment or ends at its last slash.
  const host = "github.com";
  for (let at = head.indexOf(host, Math.max(0, head.lastIndexOf("/") - host.length)); at >= 0; at = head.indexOf(host, at + 1)) {
    const separator = head[at + host.length];
    const owner = head.slice(at + host.length + 1);
    if ((separator === ":" || separator === "/") && owner) return `${owner}/${repo}`;
  }
  return undefined;
}

/** The login `gh` is authenticated as, used to pre-fill the trusted authors. */
export function githubLogin(cwd: string, run: CommandRunner = runCommand): string | undefined {
  const result = run("gh", ["api", "user", "--jq", ".login"], { cwd });
  return result.code === 0 && result.stdout ? result.stdout : undefined;
}

export function githubRepoOf(root: string, run: CommandRunner = runCommand): string | undefined {
  const result = run("git", ["remote", "get-url", "origin"], { cwd: root });
  return result.code === 0 ? parseGithubRemote(result.stdout) : undefined;
}
