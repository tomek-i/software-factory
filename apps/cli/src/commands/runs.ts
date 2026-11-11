import { existsSync, readFileSync } from "node:fs";
import {
  approveTarget,
  applyStreamLine,
  createAgentRunner,
  emptySummary,
  FactoryEvents,
  fetchIssue,
  ghPort,
  killTree,
  loadTrustedConfig,
  PipelineDriver,
  RunMachine,
  resumeTargets,
  trustedReader,
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

/** `factory run <issue>`: sync and queue the issue if needed, then start (or continue) its run and drive it until it needs someone. */
export async function runRun(cwd: string, value: string, options: { unsafe?: boolean }, deps: RunDeps = {}): Promise<string> {
  const number = parseIssueNumber(value);
  return withProjectAsync(
    cwd,
    async ({ store, project, config }) => {
      ensureQueued(store, project, config, number, deps);
      return driveIssue(store, project, config, number, options, deps);
    },
    deps.run,
  );
}

/** Drive the issue's run (starting one if needed) until it needs someone, printing progress. */
async function driveIssue(
  store: Store,
  project: Project,
  workingConfig: FactoryConfig,
  number: number,
  options: { unsafe?: boolean },
  deps: RunDeps,
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
  const onInterrupt = () => {
    for (const agent of store.listAgentRuns(run.id)) {
      if (agent.status !== "running") continue;
      if (agent.pid) killTree(agent.pid);
      store.finishAgentRun(agent.id, { status: "cancelled" });
    }
    store.releaseLease(run.id, owner);
    process.exit(130);
  };
  process.once("SIGINT", onInterrupt);
  try {
    const outcome = await driver.drive(run.id);
    return describeOutcome(outcome, store.getRun(run.id)!, number, style);
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

function cost(store: Store, runId: string): number {
  return store.listAgentRuns(runId).reduce((sum, a) => sum + (a.cost_usd ?? 0), 0);
}

/** `factory status`: one line per run. */
export function runStatus(cwd: string, options: { all?: boolean } = {}, run?: CommandRunner, style: Style = plain): string {
  return withProject(
    cwd,
    ({ store, project }) => {
      const runs = store.listRuns({ project_id: project.id }).filter((r) => options.all || !isTerminal(r.state));
      if (runs.length === 0) return options.all ? "No runs yet." : "No active runs. `factory status --all` shows finished ones.";
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
      return [
        line(header, header),
        ...rows.map((row, n) => {
          const [id, issue, state, round, money, waiting] = row as [string, string, string, string, string, string];
          return line(row, [style.detail(id), issue, style.state(runs[n]!.state, state), round, style.detail(money), style.attention(waiting)]);
        }),
      ].join("\n");
    },
    run,
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
  if (to === "capture") {
    return `${done}\nCapture and merge are not automated yet: mark the draft PR ready and merge it yourself.`;
  }
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
      new RunMachine(store, config).resume(target.id, to, { comment: options.message?.trim() || "approved" });
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
      return `Rejected ${target.id} at the ${target.waiting_gate} gate.`;
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
      return `Cancelled ${target.id}.${stopped}${kept}`;
    },
    run,
  );
}
