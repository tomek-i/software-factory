import { runCommand, type CommandRunner } from "../util/exec.js";
import { CONFIG_FILE, ConfigError, FACTORY_DIR, parseConfig } from "./load.js";
import type { FactoryConfig } from "@factory/shared";

/** Reads a repo file as it exists on the remote default branch. Undefined when it does not exist there. */
export type TrustedReader = (relPath: string) => string | undefined;

/**
 * Files that steer the agents (config, prompts, lessons) are read from the remote default branch,
 * never from a working copy: whatever branch happens to be checked out cannot change its own
 * checks, trust list, gates or prompts. Fetches once when created.
 */
export function trustedReader(root: string, defaultBranch: string, run: CommandRunner = runCommand): TrustedReader {
  const fetched = run("git", ["fetch", "--quiet", "origin", defaultBranch], { cwd: root });
  if (fetched.code !== 0) throw new ConfigError(root, [`git fetch origin ${defaultBranch} failed: ${fetched.stderr}`]);
  return (relPath) => {
    const spec = `origin/${defaultBranch}:${relPath.replace(/\\/g, "/")}`;
    const result = run("git", ["show", spec], { cwd: root });
    // runCommand trims output; files are text, so restore the final newline.
    return result.code === 0 ? `${result.stdout}\n` : undefined;
  };
}

export function loadTrustedConfig(read: TrustedReader, defaultBranch: string): FactoryConfig {
  const path = `${FACTORY_DIR}/${CONFIG_FILE}`;
  const text = read(path);
  if (text === undefined) {
    throw new ConfigError(`origin/${defaultBranch}:${path}`, [
      `not found on ${defaultBranch}; commit and push .factory/config.yaml first`,
    ]);
  }
  return parseConfig(text, `origin/${defaultBranch}:${path}`);
}
