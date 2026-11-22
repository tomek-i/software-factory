import { spawnSync } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs external tools (git, gh). Injected so tests can fake the tools they don't want to hit for real.
 * With `timeoutMs` the tool is killed when it runs longer, and the result says it timed out.
 * With `inherit` its output goes straight to this process's terminal, and the result holds none.
 * With `windowsScript` it is started through cmd, the only way Windows runs a `.cmd` script such as
 * npm, pnpm or yarn; set it on Windows only.
 */
export type CommandRunner = (cmd: string, args: string[], options: { cwd: string; timeoutMs?: number; inherit?: boolean; windowsScript?: boolean }) => ExecResult;

export const runCommand: CommandRunner = (cmd, args, { cwd, timeoutMs, inherit, windowsScript }) => {
  // Large outputs (a whole diff) exceed the 1 MB default and would fail as ENOBUFS.
  const options = { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, stdio: inherit ? "inherit" : "pipe" } as const;
  // Two calls, not one with "cmd" picked into it: only the script goes through a shell, and code
  // scanning, which can't tell callers apart, would otherwise take every git and gh call for one.
  const result = windowsScript ? spawnSync("cmd", ["/d", "/c", cmd, ...args], options) : spawnSync(cmd, args, options);
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { code: -1, stdout: "", stderr: `${[cmd, ...args.slice(0, 1)].join(" ")} timed out after ${(timeoutMs ?? 0) / 1000}s` };
    }
    // e.g. ENOENT when the tool is not installed
    return { code: -1, stdout: "", stderr: result.error.message };
  }
  return { code: result.status ?? -1, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
};
