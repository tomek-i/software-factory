import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { execa, type ResultPromise } from "execa";
import { CHECK_ENV_DENYLIST } from "../gate/gate.js";
import { isAlive, killTree } from "../util/process.js";

/** Whether nothing listens on `port`, on IPv4 or IPv6 (dev servers bind either `localhost`). */
async function portFree(port: number): Promise<boolean> {
  const tryListen = (host: string) =>
    new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT"));
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
    });
  return (await tryListen("127.0.0.1")) && (await tryListen("::1"));
}

/** A port the OS says is free right now. */
async function anyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** The first free port of `preferred` (the run's port block), or any free port when they are all taken. */
export async function freePort(preferred: number[] = []): Promise<number> {
  for (const port of preferred) if (await portFree(port)) return port;
  return anyPort();
}

/** `app.url` for a port: `{port}` replaced. */
export function appUrl(template: string, port: number): string {
  return template.replaceAll("{port}", String(port));
}

export interface StartAppOptions {
  /** `app.start`, run through the shell. */
  command: string;
  cwd: string;
  port: number;
  /** `app.port_env`: the variable that carries the port. */
  portEnv: string;
  /** `app.env`: further variables to pass through from the factory's environment. */
  passEnv?: string[];
  url: string;
  /** Server output goes here, for the report when it does not come up. */
  logFile: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** How often to ask the URL; tests make it quicker. */
  pollMs?: number;
}

export interface AppServer {
  url: string;
  /** The shell's pid; stopping kills its whole tree. */
  pid: number;
  /** Kill the server and everything it started, and wait until the shell is gone. A second call waits for the first. */
  stop(): Promise<void>;
}

/**
 * What the app gets from the factory's environment: only what a shell, Node and package managers
 * need to run, plus the names in `app.env`. An allowlist, not the checks' denylist: the app's pages
 * are screenshotted and published, so nothing it renders may come from the user's environment.
 */
export const APP_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "LANG",
  "NODE_ENV",
];

/** The app's environment: the allowlist plus `passEnv`, never a token, then the port. */
export function appEnv(env: NodeJS.ProcessEnv, portEnv: string, port: number, passEnv: string[] = []): NodeJS.ProcessEnv {
  const denied = new Set(CHECK_ENV_DENYLIST.map((n) => n.toUpperCase()));
  const wanted = new Set([...APP_ENV_ALLOWLIST, ...passEnv].map((n) => n.toUpperCase()).filter((n) => !denied.has(n)));
  const kept = Object.fromEntries(Object.entries(env).filter(([key]) => wanted.has(key.toUpperCase())));
  // BROWSER=none: dev servers such as create-react-app would otherwise open a browser window.
  return { ...kept, [portEnv]: String(port), BROWSER: "none" };
}

/** Servers started by this process and not stopped yet, killed when the process ends. */
const live = new Set<number>();

const killLive = () => {
  for (const pid of live) killServer(pid);
};
/** SIGTERM and SIGHUP end the process without an "exit" event, so they take the servers down first. */
const onSignal = (signal: NodeJS.Signals) => {
  killLive();
  // Without other listeners, Node's default for these signals was to end the process: keep that.
  if (process.listenerCount(signal) === 0) process.exit(signal === "SIGTERM" ? 143 : 129);
};

function track(pid: number): void {
  if (live.size === 0) {
    // Ctrl+C ends the factory with process.exit, which still emits "exit".
    process.on("exit", killLive);
    process.once("SIGTERM", onSignal);
    process.once("SIGHUP", onSignal);
  }
  live.add(pid);
}

function untrack(pid: number): void {
  if (!live.delete(pid) || live.size > 0) return;
  process.off("exit", killLive);
  process.off("SIGTERM", onSignal);
  process.off("SIGHUP", onSignal);
}

function killServer(pid: number): void {
  if (process.platform === "win32") {
    killTree(pid);
    return;
  }
  // Started in its own process group (detached), so the group takes down npm, the shell and the
  // server the shell started, which a kill of the shell alone would leave running.
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

export class AppStartError extends Error {}

/** The last lines of the server's log, to say why it did not come up. */
function logTail(logFile: string): string {
  try {
    return readFileSync(logFile, "utf8").trimEnd().split(/\r?\n/).slice(-20).join("\n");
  } catch {
    return "";
  }
}

/**
 * Start the app with a minimal environment (appEnv: no tokens, nothing personal; it runs code the
 * builder wrote from issue text, and its pages are published) and wait until its URL answers.
 * On any failure (exits early, never answers, cancelled) the server is killed before this throws,
 * so no caller can leave one running.
 */
export async function startApp(options: StartAppOptions): Promise<AppServer> {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const log = createWriteStream(options.logFile);
  const child: ResultPromise = execa(options.command, {
    shell: true,
    cwd: options.cwd,
    reject: false,
    windowsHide: true,
    stdin: "ignore",
    all: true,
    buffer: false,
    detached: process.platform !== "win32",
    extendEnv: false,
    env: appEnv(process.env, options.portEnv, options.port, options.passEnv),
  });
  child.all?.pipe(log);
  const pid = child.pid;
  if (pid === undefined) {
    await child;
    log.end();
    throw new AppStartError(`could not start \`${options.command}\``);
  }
  track(pid);

  // Set once the shell has exited; an object so the wait loop below sees the callback's write.
  const shell: { exitCode?: number; exited: boolean } = { exited: false };
  const done = child.then((r) => {
    shell.exited = true;
    shell.exitCode = r.exitCode;
  });
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      killServer(pid);
      // The shell exits once its tree is gone; give it a moment, then make sure.
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
      if (isAlive(pid)) killServer(pid);
      untrack(pid);
      log.end();
    })());

  const deadline = Date.now() + options.timeoutMs;
  try {
    for (;;) {
      if (options.signal?.aborted) throw new AppStartError("capture was cancelled");
      if (shell.exited) throw new AppStartError(`\`${options.command}\` exited (code ${shell.exitCode ?? "none"}) before ${options.url} answered\n${logTail(options.logFile)}`.trim());
      if (await answers(options.url)) break;
      if (Date.now() >= deadline) {
        throw new AppStartError(`${options.url} did not answer within ${Math.round(options.timeoutMs / 1000)}s after \`${options.command}\`\n${logTail(options.logFile)}`.trim());
      }
      await new Promise((r) => setTimeout(r, options.pollMs ?? 500));
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { url: options.url, pid, stop };
}

/** Whether anything answers HTTP at `url`; any status counts, a 404 at / is still a running app. */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}
