import { spawn } from "node:child_process";
import { track, untrack } from "../capture/server.js";
import { killTree } from "./process.js";

/**
 * Run a long command (narrate, the security scan) and wait for it. Exit code and stdout; the code is
 * null when it was stopped for the timeout or the signal, and its whole tree is killed then. stderr
 * goes to `log`, an open file descriptor.
 */
export function spawnAndWait(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    log: number;
    timeoutMs: number;
    signal?: AbortSignal;
    /**
     * Off Windows: send the command SIGTERM and wait this long before killing its process group, for
     * a command that starts children outside its group and stops them itself on SIGTERM.
     */
    termGraceMs?: number;
  },
): Promise<{ code: number | null; stdout: string }> {
  const { cwd, env, log, timeoutMs, signal, termGraceMs } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve({ code: null, stdout: "" });
    // Its own process group off Windows, so a kill takes its children (browsers, agents) down with it.
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", log], windowsHide: true, detached: process.platform !== "win32" });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      // The result is at the end; a runaway output must not grow without end.
      stdout = (stdout + chunk).slice(-100_000);
    });
    // Also killed if the factory itself ends mid-run (Ctrl+C, SIGTERM).
    if (child.pid !== undefined) track(child.pid);
    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (child.pid === undefined) return;
      // taskkill /T follows parent pids, so it also finds children in another group.
      if (process.platform === "win32") killTree(child.pid);
      else if (termGraceMs) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
        killTimer = setTimeout(killGroup, termGraceMs);
      } else killGroup();
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop);
    const done = () => {
      if (child.pid !== undefined) untrack(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    // "close", not "exit": stdout may still hold the result when the process exits. A leftover
    // process holding the pipe (which a kill on Windows cannot find once the parent is gone) must
    // not keep "close" from ever coming, so the pipe is dropped shortly after the exit.
    let grace: NodeJS.Timeout | undefined;
    child.on("exit", () => {
      grace = setTimeout(() => child.stdout?.destroy(), 2000);
    });
    child.on("close", (code) => {
      clearTimeout(grace);
      // It ended within the grace period: what is left of its group goes now.
      if (killTimer) {
        clearTimeout(killTimer);
        killGroup();
      }
      done();
      resolve({ code: stopped ? null : code, stdout });
    });
  });
}
