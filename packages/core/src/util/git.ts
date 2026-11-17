import { runCommand, type CommandRunner } from "./exec.js";

/** Absolute path of the repository containing cwd, or undefined when cwd is not in a git repo. */
export function findRepoRoot(cwd: string, run: CommandRunner = runCommand): string | undefined {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.code === 0 ? result.stdout : undefined;
}

/** Turn a GitHub remote URL (https or ssh) into "owner/repo". */
export function parseGithubRemote(url: string): string | undefined {
  // Parsed from the end with string handling, so a long remote cannot make a regex backtrack.
  const text = url.trim();
  for (const suffix of [".git/", ".git", "/", ""]) {
    if (!text.endsWith(suffix)) continue;
    const body = text.slice(0, text.length - suffix.length);
    const slash = body.lastIndexOf("/");
    const repo = body.slice(slash + 1);
    if (slash < 0 || !repo || /\s/.test(repo)) continue;
    // Every suffix that leaves a repo name splits at the same slash, so the owner is the same too.
    const owner = githubOwner(body.slice(0, slash));
    return owner ? `${owner}/${repo}` : undefined;
  }
  return undefined;
}

/**
 * The owner at the end of `before`: what follows the first `github.com/` or `github.com:` there,
 * up to the end without a `/` or whitespace.
 */
function githubOwner(before: string): string | undefined {
  let start = before.length;
  while (start > 0 && before[start - 1] !== "/" && !/\s/.test(before[start - 1]!)) start--;
  if (start === before.length) return undefined;
  if (before[start - 1] === "/") {
    const hostEnd = start - 1;
    const hostStart = before.lastIndexOf("/", hostEnd - 1) + 1;
    const host = before.slice(hostStart, hostEnd);
    if (host === "github.com") return before.slice(start);
  }
  const at = before.indexOf("github.com:", start);
  return at === -1 ? undefined : before.slice(at + "github.com:".length) || undefined;
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
