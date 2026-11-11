import { runCommand, type CommandRunner } from "./exec.js";

/** Absolute path of the repository containing cwd, or undefined when cwd is not in a git repo. */
export function findRepoRoot(cwd: string, run: CommandRunner = runCommand): string | undefined {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.code === 0 ? result.stdout : undefined;
}

/** Turn a GitHub remote URL (https or ssh) into "owner/repo". */
export function parseGithubRemote(url: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function githubRepoOf(root: string, run: CommandRunner = runCommand): string | undefined {
  const result = run("git", ["remote", "get-url", "origin"], { cwd: root });
  return result.code === 0 ? parseGithubRemote(result.stdout) : undefined;
}
