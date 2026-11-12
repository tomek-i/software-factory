import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  approveTarget,
  applyStreamLine,
  createAgentRunner,
  deleteMedia,
  emptySummary,
  FactoryEvents,
  fetchIssue,
  ghPort,
  killTree,
  loadTrustedConfig,
  MEDIA_MARKER,
  mediaTag,
  PipelineDriver,
  RunMachine,
  resumeTargets,
  runDirOf,
  trustedReader,
  waitingCommit,
  type CommandRunner,
  type DriveOutcome,
  type FactoryEvent,
  type GithubPort,
  type Issue,
  type Project,
  type Run,
  type Store,
} from "@factory/core";
import { isTerminal, isTrustedAuthor, type FactoryConfig, type Gate, type RunState } from "@factory/shared";
import { CliError, withProject, withProjectAsync } from "../context.js";
import { plain, type Style } from "../style.js";
import { UNTRUSTED_NOTE } from "./issues.js";
import { reconcileRuns } from "./reconcile.js";

export interface RunDeps {
  run?: CommandRunner;
  /** Environment for agents (tests point FACTORY_CLAUDE_BIN at the fake). */
  env?: NodeJS.ProcessEnv;
  github?: GithubPort;
  print?: (line: string) => void;
  /** How to style output; plain unless the caller decided colour is on. */
  style?: Style;
}

function parseIssueNumber(value: string): number {
  const n = Number(value.replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`"${value}" is not an issue number`);
  return n;
}

/** A run by full id, unique id prefix, or `#<issue>` (that issue's latest run). */
export function findRun(store: Store, project: Project, ref: string): Run {
  const runs = store.listRuns({ project_id: project.id });
  if (/^#?\d+$/.test(ref)) {
    const issue = parseIssueNumber(ref);
    const latest = runs.find((r) => r.issue_number === issue);
    if (!latest) throw new CliError(`No run for issue #${issue}.`);
    return latest;
  }
  const matches = runs.filter((r) => r.id === ref || r.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  const exact = matches.find((r) => r.id === ref);
  if (exact) return exact;
  throw new CliError(matches.length ? `"${ref}" matches several runs; use more of the id.` : `No run "${ref}". See \`factory status\`.`);
}

function formatEvent(event: FactoryEvent, style: Style): string | undefined {
  switch (event.type) {
    case "run:state":
      return style.transition(`-> ${style.state(event.to)}: ${event.reason}`);
    case "agent:start":
      return `[${event.role}] ${event.resumed ? "resuming" : "starting"} agent ${style.detail(event.agentRunId)}`;
    case "agent:activity":
      return `    ${event.summary}`;
    case "agent:end": {
      const cost = event.costUsd != null ? ` ${style.detail(`($${event.costUsd.toFixed(2)})`)}` : "";
      return `[${event.role}] ${style.agent(event.status)}${cost}`;
    }
    case "gate:check": {
      const result = style.check(event.passed, event.passed ? "passed" : "FAILED");
      return `[gate] ${event.name}: ${result} ${style.detail(`(${(event.durationMs / 1000).toFixed(1)}s)`)}`;
    }
    case "info":
      return `    ${event.message}`;
  }
}

/** The verdict file a gate is about, as a `factory show` short name. */
const GATE_FILE: Partial<Record<Gate, string>> = { triage: "triage" };

/** "See it with: `factory show ...`" for a run waiting at a gate, naming the file the gate is about. */
export function showHint(run: Pick<Run, "id" | "waiting_gate">): string {
  const file = run.waiting_gate ? GATE_FILE[run.waiting_gate] : undefined;
  return `See it with: \`factory show ${run.id}${file ? ` ${file}` : ""}\`.`;
}

function describeOutcome(outcome: DriveOutcome, run: Run, issue: number, style: Style): string {
  const id = style.detail(run.id);
  switch (outcome.kind) {
    case "parked":
      if (outcome.state === "needs_info") return `Run ${id} is ${style.state("needs_info", "waiting for answers")} on issue #${issue}.`;
      return run.waiting_gate
        ? [
            `Run ${id} is ${style.state("needs_human", `waiting at the ${run.waiting_gate} gate`)}: ${outcome.reason}`,
            showHint(run),
            style.hint(`Approve with \`factory approve ${run.id}\`, or reject with \`factory reject ${run.id} -m "<why>"\`.`),
          ].join("\n")
        : [
            `Run ${id} ${style.state("needs_human", "needs you")}: ${outcome.reason}`,
            `See \`factory logs ${run.id}\`. Send it on with \`factory resume ${run.id} --to <stage> -m "<why>"\`, or stop it with \`factory cancel ${run.id}\`.`,
          ].join("\n");
    case "finished":
      return `Run ${id} finished: ${style.state(outcome.state)}.`;
    case "rate_limited":
      return `${style.agent("rate_limited", "Usage limit reached")}${outcome.resetsAt ? ` ${style.detail(`(resets ${outcome.resetsAt})`)}` : ""}. Run \`factory run ${issue}\` again after that; the run continues where it stopped.`;
    case "stopped":
      return `Run ${id} stopped in ${style.state(outcome.state)}: ${outcome.reason}`;
  }
}

/**
 * Make sure the issue is synced and queued. Typing `factory run <n>` is itself the local decision
 * to work on it, so it queues the issue the same way `factory queue <n>` would; nobody on GitHub
 * can trigger this.
 */
function ensureQueued(store: Store, project: Project, config: FactoryConfig, number: number, deps: RunDeps): Issue {
  const print = deps.print ?? console.log;
  const known = store.getIssue(project.id, number);
  if (known?.queued_at) return known;
  // Fetch fresh before queueing: the local copy may be missing, or stale since the last sync
  // (closed or edited on GitHub), and this is about to start agents on it.
  try {
    fetchIssue(store, project, number, deps.run);
  } catch (err) {
    throw new CliError(`Could not fetch issue #${number}: ${(err as Error).message}`);
  }
  const issue = store.getIssue(project.id, number)!;
  if (issue.state !== "open") throw new CliError(`Issue #${number} is closed.`);
  store.setQueued(project.id, number, true);
  print(`Queued #${number} ${issue.title}`);
  if (!isTrustedAuthor(config, issue.author)) print(UNTRUSTED_NOTE);
  return store.getIssue(project.id, number)!;
}

/**
 * `factory run <issue...>`: sync and queue each issue if needed, then start (or continue) its run
 * and drive it until it needs someone. Several issues run at once, up to `concurrency.max_runs`.
 */
export async function runRun(cwd: string, values: string[], options: { unsafe?: boolean }, deps: RunDeps = {}): Promise<string> {
  // Validate every argument before anything is queued or started.
  const numbers = [...new Set(values.map(parseIssueNumber))];
  return withProjectAsync(
    cwd,
    async ({ store, project, config }) => {
      for (const line of reconcileRuns(store, project, config, deps)) (deps.print ?? console.log)(line);
      if (numbers.length === 1) {
        ensureQueued(store, project, config, numbers[0]!, deps);
        return driveIssue(store, project, config, numbers[0]!, options, deps);
      }
      return runMany(store, project, config, numbers, options, deps);
    },
    deps.run,
  );
}

/** Drive several issues concurrently; every line, live or final, is prefixed with its issue. */
async function runMany(
  store: Store,
  project: Project,
  workingConfig: FactoryConfig,
  numbers: number[],
  options: { unsafe?: boolean },
  deps: RunDeps,
): Promise<string> {
  const print = deps.print ?? console.log;
  const style = deps.style ?? plain;
  const prefix = (n: number) => (text: string) =>
    text
      .split("\n")
      .map((line) => `${style.detail(`[#${n}]`)} ${line}`)
      .join("\n");
  const depsFor = (n: number): RunDeps => ({ ...deps, print: (line) => print(prefix(n)(line)) });

  const ready: number[] = [];
  const results = new Map<number, string>();
  let failed = false;
  for (const n of numbers) {
    try {
      ensureQueued(store, project, workingConfig, n, depsFor(n));
      ready.push(n);
    } catch (err) {
      results.set(n, prefix(n)(`Skipped: ${(err as Error).message}`));
      failed = true;
    }
  }

  // The cap comes from the trusted config, like everything else that steers a run.
  const defaultBranch = workingConfig.project.default_branch;
  const limit = loadTrustedConfig(trustedReader(project.repo_path, defaultBranch, deps.run), defaultBranch).concurrency.max_runs;
  const pending = [...ready];
  let limited = false;
  const worker = async () => {
    for (let n = pending.shift(); n !== undefined; n = pending.shift()) {
      try {
        const message = await driveIssue(store, project, workingConfig, n, options, depsFor(n), (outcome) => {
          if (outcome.kind === "rate_limited") limited = true;
        });
        results.set(n, prefix(n)(message));
      } catch (err) {
        results.set(n, prefix(n)(`Failed: ${(err as Error).message}`));
        failed = true;
      }
      // Starting more runs after the usage limit would only create runs that stop straight away.
      if (limited) {
        for (const waiting of pending.splice(0)) {
          results.set(waiting, prefix(waiting)(`Not started: the usage limit was reached. Run \`factory run ${waiting}\` after it resets.`));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ready.length) }, worker));

  const summary = numbers.map((n) => results.get(n)!).join("\n");
  // A non-zero exit when an issue could not run, with every issue's outcome still reported.
  if (failed) throw new CliError(`not every issue ran:\n${summary}`);
  return summary;
}

/**
 * Ctrl+C cleanups for the runs this process is driving. One SIGINT handler stops all of them
 * before exiting, so a second run's lease is not left behind when several run at once.
 */
const interrupts = new Set<() => void>();

/** Stop every run this process is driving: kill its agents and give its lease back. */
export function stopActiveRuns(): number {
  const count = interrupts.size;
  for (const stop of interrupts) stop();
  return count;
}

function onSigint() {
  stopActiveRuns();
  process.exit(130);
}

/** Drive the issue's run (starting one if needed) until it needs someone, printing progress. */
async function driveIssue(
  store: Store,
  project: Project,
  workingConfig: FactoryConfig,
  number: number,
  options: { unsafe?: boolean },
  deps: RunDeps,
  onOutcome?: (outcome: DriveOutcome) => void,
): Promise<string> {
  const print = deps.print ?? console.log;
  const style = deps.style ?? plain;
  const issue = store.getIssue(project.id, number)!;
  const defaultBranch = workingConfig.project.default_branch;
  const read = trustedReader(project.repo_path, defaultBranch, deps.run);
  const config = loadTrustedConfig(read, defaultBranch);

  const events = new FactoryEvents();
  events.on((e) => {
    const line = formatEvent(e, style);
    if (line) print(line);
  });
  const owner = `cli-${process.pid}`;
  const driver = new PipelineDriver({
    store,
    project,
    config,
    read,
    runAgent: createAgentRunner({ store, events, env: deps.env }),
    github: deps.github ?? ghPort(project, deps.run),
    owner,
    events,
    run: deps.run,
  });

  if (config.checks.length === 0) {
    print("Warning: no checks are configured in .factory/config.yaml on the default branch; the quality gate only scans for secrets.");
  }
  let run = driver.startRun(number, { unsafe: options.unsafe });
  if (options.unsafe && !run.unsafe) print(`--unsafe ignored: run ${run.id} already exists without it.`);
  // Running an issue that was waiting for its author means "they answered": triage it again.
  if (run.state === "needs_info") run = driver.retriage(run.id);
  print(`Run ${style.detail(run.id)} (${style.state(run.state)}) for #${number} ${issue.title}`);

  // Ctrl+C: stop this process's agent and give the lease back so the run can be continued
  // right away. Only rows still running are ours: this process holds the run's lease.
  const stop = () => {
    for (const agent of store.listAgentRuns(run.id)) {
      if (agent.status !== "running") continue;
      if (agent.pid) killTree(agent.pid);
      store.finishAgentRun(agent.id, { status: "cancelled" });
    }
    store.releaseLease(run.id, owner);
  };
  if (interrupts.size === 0) process.once("SIGINT", onSigint);
  interrupts.add(stop);
  try {
    const outcome = await driver.drive(run.id);
    onOutcome?.(outcome);
    return describeOutcome(outcome, store.getRun(run.id)!, number, style);
  } finally {
    interrupts.delete(stop);
    if (interrupts.size === 0) process.off("SIGINT", onSigint);
  }
}

function cost(store: Store, runId: string): number {
  return store.listAgentRuns(runId).reduce((sum, a) => sum + (a.cost_usd ?? 0), 0);
}

/** `factory status`: one line per run, after finishing runs whose PR was merged or closed on GitHub. */
export function runStatus(cwd: string, options: { all?: boolean } = {}, deps: Pick<RunDeps, "run" | "style" | "github"> = {}): string {
  const style = deps.style ?? plain;
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const reconciled = reconcileRuns(store, project, config, deps);
      const notes = reconciled.length ? `${reconciled.join("\n")}\n\n` : "";
      const runs = store.listRuns({ project_id: project.id }).filter((r) => options.all || !isTerminal(r.state));
      if (runs.length === 0) return notes + (options.all ? "No runs yet." : "No active runs. `factory status --all` shows finished ones.");
      const header = ["RUN", "ISSUE", "STATE", "ROUND", "COST", "WAITING"];
      const rows = runs.map((r) => [
        r.id,
        r.issue_number ? `#${r.issue_number}` : "-",
        r.state,
        `b${r.build_iterations + 1} r${r.review_rounds + 1}`,
        `$${cost(store, r.id).toFixed(2)}`,
        r.waiting_gate ?? "",
      ]);
      const widths = header.map((_, i) => Math.max(...[header, ...rows].map((row) => row[i]!.length)));
      // Widths and padding come from the plain text; only the cell content is styled, never the padding.
      const line = (cells: string[], styled: string[]) =>
        styled.map((cell, i) => cell + " ".repeat(widths[i]! - cells[i]!.length)).join("  ").trimEnd();
      return notes + [
        line(header, header),
        ...rows.map((row, n) => {
          const [id, issue, state, round, money, waiting] = row as [string, string, string, string, string, string];
          return line(row, [style.detail(id), issue, style.state(runs[n]!.state, state), round, style.detail(money), style.attention(waiting)]);
        }),
      ].join("\n");
    },
    deps.run,
  );
}

function renderLogs(store: Store, runId: string, style: Style): string[] {
  const lines = store.listEvents(runId).map((e) => {
    const from = e.from_state ? style.state(e.from_state) : "-";
    return `${style.detail(e.created_at)}  ${from} -> ${style.state(e.to_state)}  ${e.reason}`;
  });
  for (const agent of store.listAgentRuns(runId)) {
    const cost = agent.cost_usd != null ? ` ${style.detail(`$${agent.cost_usd.toFixed(2)}`)}` : "";
    lines.push(
      "",
      `agent ${style.detail(agent.id)} ${agent.role} ${style.agent(agent.status)}${cost}  ${style.detail(`log: ${agent.log_path}`)}`,
    );
    if (agent.excerpt) lines.push(...agent.excerpt.split("\n").map((l) => `  ${l}`));
  }
  return lines;
}

/** `factory logs <run>`: events and agent excerpts; with --follow, keeps printing until the run stops moving. */
export async function runLogs(
  cwd: string,
  ref: string,
  options: { follow?: boolean; intervalMs?: number },
  deps: { run?: CommandRunner; print?: (line: string) => void; style?: Style } = {},
): Promise<string> {
  const print = deps.print ?? console.log;
  const style = deps.style ?? plain;
  return withProjectAsync(
    cwd,
    async ({ store, project }) => {
      const run = findRun(store, project, ref);
      if (!options.follow) return renderLogs(store, run.id, style).join("\n");

      let events = 0;
      const offsets = new Map<string, number>();
      for (;;) {
        for (const e of store.listEvents(run.id).slice(events)) {
          print(style.transition(`-> ${style.state(e.to_state)}: ${e.reason}`));
          events++;
        }
        const agents = store.listAgentRuns(run.id);
        for (const agent of agents) {
          if (!agent.log_path || !existsSync(agent.log_path)) continue;
          const text = readFileSync(agent.log_path, "utf8");
          const from = offsets.get(agent.id) ?? 0;
          // Only complete lines; a partially written line is picked up next time.
          const end = text.lastIndexOf("\n") + 1;
          if (end <= from) continue;
          for (const line of text.slice(from, end).split("\n")) {
            for (const activity of applyStreamLine(emptySummary(), line)) print(`[${agent.role}] ${activity}`);
          }
          offsets.set(agent.id, end);
        }
        const current = store.getRun(run.id)!;
        // A live lease means a worker is on it; a stale agent row from a crashed worker does not.
        const busy = current.lease_expires_at !== null && current.lease_expires_at > new Date().toISOString();
        if (!busy && (isTerminal(current.state) || current.state === "needs_human" || current.state === "needs_info")) {
          return `Run ${style.detail(run.id)} is ${style.state(current.state)}.`;
        }
        await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
      }
    },
    deps.run,
  );
}

/**
 * After approve or resume, carry on driving the run in this terminal, like `factory run`, unless
 * the caller said --no-run or the run went somewhere the driver cannot take further.
 */
async function continueRun(
  store: Store,
  project: Project,
  config: FactoryConfig,
  run: Run,
  to: RunState,
  done: string,
  options: { run?: boolean },
  deps: RunDeps,
): Promise<string> {
  if (isTerminal(to) || run.issue_number === null) return done;
  if (options.run === false) return `${done}\nContinue with \`factory run ${run.issue_number}\`.`;
  // Not re-queued here: the issue may have been unqueued on purpose, or closed on GitHub since.
  if (!store.getIssue(project.id, run.issue_number)?.queued_at) {
    return `${done}\nIssue #${run.issue_number} is no longer queued, so the run was not continued. \`factory run ${run.issue_number}\` queues it again and continues.`;
  }
  (deps.print ?? console.log)(done);
  return driveIssue(store, project, config, run.issue_number, {}, deps);
}

/** `factory approve <run>`: let a run waiting at a gate continue, and keep driving it unless --no-run. */
export async function runApprove(
  cwd: string,
  ref: string,
  options: { message?: string; run?: boolean },
  deps: RunDeps = {},
): Promise<string> {
  return withProjectAsync(
    cwd,
    async ({ store, project, config }) => {
      const target = findRun(store, project, ref);
      if (target.state !== "needs_human" || !target.waiting_gate) {
        throw new CliError(`Run ${target.id} is not waiting at a gate (it is ${target.state}).`);
      }
      const to = approveTarget(target);
      if (!to) throw new CliError(`Approving the ${target.waiting_gate} gate is not supported yet.`);
      const gate = target.waiting_gate;
      // A merge approval is for the commit that was waiting, so a later change cannot ride on it.
      const commitSha = gate === "merge" ? waitingCommit(store.listEvents(target.id)) : undefined;
      new RunMachine(store, config).resume(target.id, to, { comment: options.message?.trim() || "approved", commitSha });
      const done = `Approved the ${gate} gate of ${target.id}; it moves to ${to}.`;
      return continueRun(store, project, config, target, to, done, options, deps);
    },
    deps.run,
  );
}

/**
 * `factory resume <run> --to <stage> -m <why>`: send a run parked for a human (an escalation such
 * as a failed agent or the build cap) back to an earlier stage or one step onward, and keep
 * driving it unless --no-run.
 */
export async function runResume(
  cwd: string,
  ref: string,
  options: { to: string; message: string; resetLoops?: boolean; run?: boolean },
  deps: RunDeps = {},
): Promise<string> {
  return withProjectAsync(
    cwd,
    async ({ store, project, config }) => {
      if (!options.message?.trim()) throw new CliError("Say why with -m.");
      const target = findRun(store, project, ref);
      if (target.state !== "needs_human") throw new CliError(`Run ${target.id} is not waiting for you (it is ${target.state}).`);
      const allowed = resumeTargets(target);
      if (!allowed.includes(options.to as RunState)) {
        throw new CliError(`Run ${target.id} can resume to: ${allowed.join(", ")}.`);
      }
      const to = options.to as RunState;
      new RunMachine(store, config).resume(target.id, to, { comment: options.message, resetLoops: options.resetLoops });
      const loops = options.resetLoops ? " with a fresh loop budget" : "";
      return continueRun(store, project, config, target, to, `Resumed ${target.id} to ${to}${loops}.`, options, deps);
    },
    deps.run,
  );
}

/**
 * Best effort: a run that ends without being merged takes its screenshots release (a draft, see
 * uploadMedia) with it. Returns a line for the command's output, or "" when it had none.
 */
function dropMedia(project: Project, runId: string, run?: CommandRunner): string {
  const marker = join(runDirOf(project.repo_path, runId), MEDIA_MARKER);
  if (!existsSync(marker)) return "";
  try {
    deleteMedia(project, runId, run);
    rmSync(marker);
    return `\nDeleted its screenshots release ${mediaTag(runId)}.`;
  } catch (err) {
    return `\nCould not delete its screenshots release (${(err as Error).message.split("\n")[0]}); delete it with \`gh release delete ${mediaTag(runId)}\`.`;
  }
}

/** `factory reject <run> -m <why>`: end a run waiting at a gate. */
export function runReject(cwd: string, ref: string, options: { message: string }, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      if (!options.message?.trim()) throw new CliError("Say why with -m.");
      const target = findRun(store, project, ref);
      if (target.state !== "needs_human" || !target.waiting_gate) {
        throw new CliError(`Run ${target.id} is not waiting at a gate (it is ${target.state}).`);
      }
      new RunMachine(store, config).resume(target.id, "rejected", { comment: options.message });
      return `Rejected ${target.id} at the ${target.waiting_gate} gate.${dropMedia(project, target.id, run)}`;
    },
    run,
  );
}

/** `factory cancel <run>`: stop its agent (and everything the agent started) and end the run. The worktree is kept. */
export function runCancel(cwd: string, ref: string, options: { message?: string }, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const target = findRun(store, project, ref);
      if (isTerminal(target.state)) throw new CliError(`Run ${target.id} is already ${target.state}.`);
      // A pid is only trusted while a worker holds the lease: after a crash the agent row can
      // still say "running" and its pid may since belong to an unrelated process.
      const driven = target.lease_expires_at !== null && target.lease_expires_at > new Date().toISOString();
      const running = driven ? store.listAgentRuns(target.id).filter((a) => a.status === "running" && a.pid) : [];
      for (const agent of running) killTree(agent.pid!);
      new RunMachine(store, config).cancel(target.id, options.message?.trim() || "cancelled from the CLI");
      const stopped = running.length ? ` Stopped ${running.length} agent process${running.length > 1 ? "es" : ""}.` : "";
      const kept = target.worktree_path ? `\nThe worktree is kept for inspection: ${target.worktree_path}` : "";
      return `Cancelled ${target.id}.${stopped}${kept}${dropMedia(project, target.id, run)}`;
    },
    run,
  );
}
