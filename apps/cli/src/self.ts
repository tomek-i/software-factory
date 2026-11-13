import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot, type CommandRunner } from "@factory/core";
import { CliError } from "./context.js";

/** This CLI's own file, for refuseRunningOnItself. */
export const CLI_FILE = fileURLToPath(import.meta.url);

function canonical(path: string): string {
  const real = realpathSync.native(path);
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/**
 * Refuse to drive runs with a copy of the factory that lives in the repository the runs change
 * (its checkout or one of its `.worktrees/`): a merged PR, or an agent reaching outside its
 * worktree, would change the code that is running. Dogfooding uses a pinned copy elsewhere.
 * Folders are compared, not repositories: a clone nested in the repository is refused too, and a
 * `git worktree` of it outside its folder is allowed (its files are as separate as a clone's).
 */
export function refuseRunningOnItself(cwd: string, cliFile: string = CLI_FILE, run?: CommandRunner): void {
  const root = findRepoRoot(cwd, run);
  if (!root) return; // the command itself says it is not in a repository
  const inside = relative(canonical(root), canonical(cliFile));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return;
  throw new CliError(
    "This copy of the factory is inside the repository it would change. Run it from a pinned copy (see Dogfooding in the README).",
  );
}
