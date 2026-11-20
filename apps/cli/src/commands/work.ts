import { dirname } from "node:path";
import {
  asWorker,
  DEFAULT_MAX_RUNS,
  listRegistered,
  openRegisteredProject,
  reconcileAndSweep,
  reportLines,
  requestStop,
  runCommand,
  sameProjectPath,
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
import { CliError } from "../context.js";
import { refuseRunningOnItself } from "../self.js";
import { plain, type Style } from "../style.js";
import { describeOutcome, formatEvent } from "./runs.js";

export interface WorkDeps {
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  github?: (project: Project) => GithubPort | undefined;
  print?: (line: string) => void;
  style?: Style;
  /** Aborted on Ctrl+C: interrupts the runs, like `factory stop --now`. */
  signal?: AbortSignal;
  projects?: () => RegistryEntry[];
  /** The folder it was started in: without `all`, only the registered project containing it is worked on. */
  cwd?: string;
  /** What finishing runs whose PR was merged or closed reports, per project, before work starts. */
  reconcile?: (ctx: ProjectContext) => string[];
  /** For tests: the scheduler's other dependencies. */
  scheduler?: Partial<SchedulerOptions>;
}

export function parseMaxRuns(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`--max-runs must be a whole number of 1 or more, not "${value}"`);
  return n;
}

/**
 * Refuse to work with a copy of the factory that lives in any project it would change, as
 * `factory run` does for the repository it runs in (see refuseRunningOnItself).
 */
export function refuseRunningOnAnyProject(projects: () => RegistryEntry[] = listRegistered): void {
  for (const project of projects()) refuseRunningOnItself(project.path);
}

export interface WorkOptions {
  maxRuns?: number;
  /** Work on every project in the project list, not only the one it was started in. */
  all?: boolean;
}

/**
 * `factory work`: work through the queue of the project it was started in (of every project in the
 * project list with `all`) until stopped.
 * Resolves with the last line to print; `interrupted` says the runs were stopped mid-way.
 */
export async function runWork(options: WorkOptions, deps: WorkDeps = {}): Promise<{ message: string; interrupted: boolean }> {
  try {
    return await asWorker(() => work(options, deps));
  } catch (err) {
    // e.g. refused while `factory upgrade` runs
    throw err instanceof ServiceError ? new CliError(err.message) : err;
  }
}

/**
 * The main checkout of the repository containing cwd, so a folder inside one of its worktrees (a
 * run's, under `.worktrees`) counts as that project rather than as an unregistered repo of its own.
 */
function mainCheckout(cwd: string, run: CommandRunner = runCommand): string | undefined {
  const result = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  return result.code === 0 ? dirname(result.stdout) : undefined;
}

/**
 * The projects to work on, read again on every tick, and the ones they are at the start: the whole
 * list with `all`, otherwise the registered project containing cwd, so a worker started in one repo
 * leaves the other queues alone.
 */
function chosenProjects(options: WorkOptions, deps: WorkDeps): { projects: () => RegistryEntry[]; entries: RegistryEntry[] } {
  const registered = deps.projects ?? listRegistered;
  if (options.all) {
    const entries = registered();
    if (entries.length === 0) throw new CliError("No projects registered. Run `factory init` in a repository first.");
    return { projects: registered, entries };
  }
  const root = mainCheckout(deps.cwd ?? process.cwd(), deps.run);
  const projects = () => (root === undefined ? [] : registered().filter((entry) => sameProjectPath(entry.path, root)));
  const entries = projects();
  if (entries.length === 0) {
    throw new CliError("This folder is not in a registered project. Run `factory init` here, or `factory work --all` to work on every registered project.");
  }
  return { projects, entries };
}

async function work(options: WorkOptions, deps: WorkDeps): Promise<{ message: string; interrupted: boolean }> {
  // A `factory stop` sent while it is still starting up (reconciling below) counts.
  const startedAt = Date.now();
  const print = deps.print ?? console.log;
  const style = deps.style ?? plain;
  const { projects, entries } = chosenProjects(options, deps);
  refuseRunningOnAnyProject(() => entries);
  const openProject = deps.scheduler?.open ?? openRegisteredProject;
  // Checked on every open, not only at start: a project can be registered while the worker runs.
  const open = (entry: RegistryEntry): ProjectContext => {
    refuseRunningOnItself(entry.path);
    return openProject(entry);
  };

  const reconcile = deps.reconcile ?? ((ctx) => reportLines(reconcileAndSweep(ctx.store, ctx.project, ctx.config, { run: deps.run, github: deps.github?.(ctx.project) })));
  for (const entry of entries) {
    let ctx: ProjectContext;
    try {
      ctx = open(entry);
    } catch {
      continue; // the scheduler reports it
    }
    try {
      for (const line of reconcile(ctx)) print(`${style.detail(`[${entry.name}]`)} ${line}`);
    } finally {
      // A test's open() hands out a shared context; only close what this opened.
      if (!deps.scheduler?.open) ctx.store.close();
    }
  }

  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const which = options.all ? `the queues of ${entries.length} project${entries.length === 1 ? "" : "s"}` : `the queue of ${entries[0]!.name}`;
  print(`Working through ${which}, up to ${maxRuns} run${maxRuns === 1 ? "" : "s"} at once.`);
  print(style.hint("Stop with `factory stop` (finishes the runs going on) or `factory stop --now`; Ctrl+C interrupts."));
  const scheduler = new Scheduler({
    maxRuns,
    startedAt,
    projects,
    run: deps.run,
    env: deps.env,
    github: deps.github,
    onEvent: (event) => {
      const line = describeSchedulerEvent(event, style);
      if (line) print(line);
    },
    ...deps.scheduler,
    open,
  });
  const result = await scheduler.run(deps.signal);
  return result === "drained"
    ? { message: "Stopped: no runs are going on.", interrupted: false }
    : { message: "Interrupted. The runs continue on the next `factory work`, or with `factory run <n>`.", interrupted: true };
}

/** A scheduler event as a terminal line, or undefined for one not worth a line. */
export function describeSchedulerEvent(event: SchedulerEvent, style: Style): string | undefined {
  const prefix = (project: string, issue?: number) => (text: string) =>
    text
      .split("\n")
      .map((line) => `${style.detail(`[${project}${issue === undefined ? "" : `#${issue}`}]`)} ${line}`)
      .join("\n");
  switch (event.type) {
    case "run": {
      const line = formatEvent(event.event, style);
      return line === undefined ? undefined : prefix(event.project, event.issue)(line);
    }
    case "started":
      return prefix(event.project, event.issue)(
        `Run ${style.detail(event.run.id)} (${style.state(event.run.state)}) for #${event.issue} ${event.run.title}${event.recovered ? ", continuing where it stopped" : ""}`,
      );
    case "finished":
      return prefix(event.project, event.issue)(
        // The scheduler continues the run itself once the limit resets.
        event.outcome.kind === "rate_limited" ? `${style.agent("rate_limited", "Usage limit reached")}; the run continues once it resets.` : describeOutcome(event.outcome, event.run, event.issue, style),
      );
    case "failed":
      return prefix(event.project, event.issue)(`Failed: ${event.error}`);
    case "skipped":
      return prefix(event.project, event.issue)(`Skipped: ${event.reason}`);
    case "notice":
      return prefix(event.project, event.issue)(`Warning: ${event.message}`);
    case "error":
      return style.attention(`Error: ${event.message}. Trying again shortly.`);
    case "paused":
      return style.attention(`Usage limit reached: starting and continuing nothing until ${event.until}.`);
    case "resumed":
      return "Usage limit reset: carrying on.";
    case "stopping":
      return event.now
        ? style.attention(`Stopping now: interrupted ${event.interrupted} run${event.interrupted === 1 ? "" : "s"}.`)
        : style.attention("Stopping: finishing the runs going on, starting no more.");
  }
}

/** `factory stop`: asks every running `factory work` and `factory serve` to stop, through a file they check. */
export function runStop(options: { now?: boolean }, file?: string, style: Style = plain): string {
  requestStop({ now: options.now }, file);
  return options.now
    ? `Asked any running \`factory work\` or \`factory serve\` to interrupt its runs and exit. ${style.hint("The runs continue on the next `factory work` or `factory serve`, or with `factory run <n>`.")}`
    : "Asked any running `factory work` or `factory serve` to start no more runs, finish the ones going on, and exit.";
}
