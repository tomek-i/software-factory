import { spawnSync } from "node:child_process";

/**
 * Kill a process and everything it started. Agents spawn shells, test runners and dev servers;
 * killing only the direct child would leave those running.
 */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  spawnSync("pkill", ["-TERM", "-P", String(pid)]);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // ESRCH: already gone, which is what we wanted.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/** Whether a process with this pid is still running. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
