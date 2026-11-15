import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_RUNS,
  listRegistered,
  openRegisteredProject,
  reconcileAndSweep,
  reportLines,
  Scheduler,
  ServiceError,
  type CommandRunner,
  type GithubPort,
  type Project,
  type ProjectContext,
  type RegistryEntry,
  type SchedulerEvent,
  type SchedulerOptions,
} from "@factory/core";
import { EventHub } from "./hub.js";
import { ProjectSet } from "./projects.js";
import { newToken } from "./security.js";
import { createServer } from "./server.js";

export const DEFAULT_PORT = 4180;

export interface ServeOptions {
  port?: number;
  maxRuns?: number;
  /** Open the browser on the link. */
  open?: boolean;
}

export interface ServeDeps {
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  github?: (project: Project) => GithubPort | undefined;
  print?: (line: string) => void;
  /** Aborted on Ctrl+C: interrupts the runs, like `factory stop --now`. */
  signal?: AbortSignal;
  projects?: () => RegistryEntry[];
  /** Opens a project; the CLI wraps it to refuse a project the factory itself lives in. */
  openProject?: (entry: RegistryEntry) => ProjectContext;
  /** What finishing runs whose PR was merged or closed reports, per project, before serving. */
  reconcile?: (ctx: ProjectContext) => string[];
  /** Also told every scheduler event, e.g. to print it. */
  onEvent?: (event: SchedulerEvent) => void;
  openBrowser?: (url: string) => void;
  token?: string;
  webRoot?: string;
  /** Called once listening, with the link to open. */
  onListening?: (url: string) => void;
  /** For tests: the scheduler's other dependencies. */
  scheduler?: Partial<SchedulerOptions>;
}

/** Where the built web app is, through the workspace package so it works from the pinned copy too. */
export function defaultWebRoot(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("@factory/web/package.json")), "dist");
}

export function openInBrowser(url: string): void {
  // `start` takes its first quoted argument as a window title, hence the empty one.
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  // No browser to open is not a reason to stop serving: the link is printed.
  child.on("error", () => {});
  child.unref();
}

/**
 * `factory serve`: the web app and its API on 127.0.0.1, with the scheduler working through every
 * project's queue as `factory work` does. The scheduler and the routes share one context per project.
 * Resolves once stopped, like `factory work`.
 */
export async function startServe(options: ServeOptions, deps: ServeDeps = {}): Promise<{ message: string; interrupted: boolean }> {
  // A `factory stop` sent while it is still starting up counts.
  const startedAt = Date.now();
  const print = deps.print ?? console.log;
  const list = deps.projects ?? listRegistered;
  const set = new ProjectSet(list, deps.openProject ?? openRegisteredProject);
  const entries = list();
  if (entries.length === 0) throw new ServiceError("No projects registered. Run `factory init` in a repository first.");

  const reconcile = deps.reconcile ?? ((ctx) => reportLines(reconcileAndSweep(ctx.store, ctx.project, ctx.config, { run: deps.run, github: deps.github?.(ctx.project) })));
  for (const entry of entries) {
    let ctx: ProjectContext;
    try {
      ctx = set.open(entry);
    } catch {
      continue; // the projects screen and the scheduler report it
    }
    for (const line of reconcile(ctx)) print(`[${entry.name}] ${line}`);
  }

  const hub = new EventHub();
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const scheduler = new Scheduler({
    maxRuns,
    startedAt,
    projects: list,
    run: deps.run,
    env: deps.env,
    github: deps.github,
    onEvent: (event) => {
      hub.publish(event);
      deps.onEvent?.(event);
    },
    ...deps.scheduler,
    open: (entry) => set.open(entry),
  });

  const token = deps.token ?? newToken();
  const port = options.port ?? DEFAULT_PORT;
  const app = createServer({ projects: set, hub, token, port, scheduler, run: deps.run, github: deps.github, webRoot: deps.webRoot ?? defaultWebRoot() });
  try {
    await app.listen({ host: "127.0.0.1", port });
  } catch (err) {
    set.close();
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") throw new ServiceError(`Port ${port} is in use. Pick another with --port.`);
    throw err;
  }
  const address = app.server.address();
  const url = `http://127.0.0.1:${address && typeof address === "object" ? address.port : port}/?token=${token}`;
  print(`Serving ${entries.length} project${entries.length === 1 ? "" : "s"}, up to ${maxRuns} run${maxRuns === 1 ? "" : "s"} at once.`);
  print(`Open ${url}`);
  print("Stop with `factory stop` (finishes the runs going on) or `factory stop --now`; Ctrl+C interrupts.");
  deps.onListening?.(url);
  if (options.open !== false) (deps.openBrowser ?? openInBrowser)(url);

  const result = await scheduler.run(deps.signal);
  await app.close();
  // Interrupted drives are left behind, not awaited (see stopNow), and may still write before the
  // process exits; their stores stay open until then.
  if (result === "drained") set.close();
  return result === "drained"
    ? { message: "Stopped: no runs are going on.", interrupted: false }
    : { message: "Interrupted. The runs continue on the next `factory serve` or `factory work`, or with `factory run <n>`.", interrupted: true };
}
