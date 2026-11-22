import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs external tools (git, gh). Injected so tests can fake the tools they don't want to hit for real.
 * With `timeoutMs` the tool is killed when it runs longer, and the result says it timed out.
 * With `inherit` its output goes straight to this process's terminal, and the result holds none.
 * `windowsScript` marks a `.cmd` script such as npm, which Windows runs only through cmd: only
 * `runPackageManager` acts on it.
 */
export type CommandRunner = (cmd: string, args: string[], options: { cwd: string; timeoutMs?: number; inherit?: boolean; windowsScript?: boolean }) => ExecResult;

type SpawnOptions = { cwd: string; timeoutMs?: number; inherit?: boolean };

function spawnOptions({ cwd, timeoutMs, inherit }: SpawnOptions) {
  // Large outputs (a whole diff) exceed the 1 MB default and would fail as ENOBUFS.
  return { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, stdio: inherit ? "inherit" : "pipe" } as const;
}

function execResult(result: SpawnSyncReturns<string>, cmd: string, args: string[], timeoutMs: number | undefined): ExecResult {
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { code: -1, stdout: "", stderr: `${[cmd, ...args.slice(0, 1)].join(" ")} timed out after ${(timeoutMs ?? 0) / 1000}s` };
    }
    // e.g. ENOENT when the tool is not installed
    return { code: -1, stdout: "", stderr: result.error.message };
  }
  return { code: result.status ?? -1, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

/** Never through a shell: each argument reaches the tool as it is. */
export const runCommand: CommandRunner = (cmd, args, options) => execResult(spawnSync(cmd, args, spawnOptions(options)), cmd, args, options.timeoutMs);

/**
 * Runs npm, pnpm or yarn, through cmd when `windowsScript` says it is a `.cmd` script on Windows.
 * Kept apart from runCommand so only package manager calls can reach a shell: code scanning, which
 * can't tell callers apart, would otherwise take every git and gh argument for shell input.
 */
export const runPackageManager: CommandRunner = (cmd, args, options) =>
  options.windowsScript ? execResult(spawnSync("cmd", ["/d", "/c", cmd, ...args], spawnOptions(options)), cmd, args, options.timeoutMs) : runCommand(cmd, args, options);
