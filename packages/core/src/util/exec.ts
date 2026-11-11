import { spawnSync } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs external tools (git, gh). Injected so tests can fake the tools they don't want to hit for real. */
export type CommandRunner = (cmd: string, args: string[], options: { cwd: string }) => ExecResult;

export const runCommand: CommandRunner = (cmd, args, { cwd }) => {
  // Large outputs (a whole diff) exceed the 1 MB default and would fail as ENOBUFS.
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) {
    // e.g. ENOENT when the tool is not installed
    return { code: -1, stdout: "", stderr: result.error.message };
  }
  return { code: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};
