import { existsSync, readFileSync } from "node:fs";
import {
  applyStreamLine,
  approveRun,
  cancelRun,
  continuation,
  driveIssue,
  emptySummary,
  ensureQueued,
  FactoryEvents,
  findRun,
  reconcileAndSweep,
  rejectRun,
  reportLines,
  resumeRun,
  runCost,
  trustedConfig,
  type CommandRunner,
  type DriveOutcome,
  type DroppedMedia,
  type FactoryEvent,
  type GithubPort,
  type Issue,
  type Run,
  type ServiceContext,
  type Store,
} from "@factory/core";
import { isTerminal, type Gate, type RunState } from "@factory/shared";
import { CliError, withProject, withProjectAsync } from "../context.js";
import { plain, type Style } from "../style.js";
import { UNTRUSTED_NOTE } from "./issues.js";
import { lessonsNote } from "./lessons.js";

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

export function formatEvent(event: FactoryEvent, style: Style): string | undefined {
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
const GATE_FILE: Partial<Record<Gate, string>> = { triage: "triage", critic: "critic" };

/** "See it with: `factory show ...`" for a run waiting at a gate, naming the file the gate is about. */
export function showHint(run: Pick<Run, "id" | "waiting_gate">): string {
  const file = run.waiting_gate ? GATE_FILE[run.waiting_gate] : undefined;
  return `See it with: \`factory show ${run.id}${file ? ` ${file}` : ""}\`.`;
}

export function describeOutcome(outcome: DriveOutcome, run: Run, issue: number, style: Style): string {
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
 * Make sure the issue is synced and queued (see ensureQueued in core): typing `factory run <n>` is
 * itself the local decision to work on it. Says so when it queued the issue just now.
 */
function queueForRun(ctx: ServiceContext, number: number, deps: RunDeps): Issue {
  const print = deps.print ?? console.log;
  const { issue, queued, trusted } = ensureQueued(ctx, number, deps.run);
  if (queued) {
    print(`Queued #${number} ${issue.title}`);
    if (!trusted) print(UNTRUSTED_NOTE);
  }
  return issue;
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
    async (ctx) => {
      for (const line of reportLines(reconcileAndSweep(ctx.store, ctx.project, ctx.config, deps))) (deps.print ?? console.log)(line);
      if (numbers.length === 1) {
        queueForRun(ctx, numbers[0]!, deps);
        return (await driveAndReport(ctx, numbers[0]!, options, deps)).message;
      }
      return runMany(ctx, numbers, options, deps);
    },
    deps.run,
  );
}

/** Drive several issues concurrently; every line, live or final, is prefixed with its issue. */
async function runMany(ctx: ServiceContext, numbers: number[], options: { unsafe?: boolean }, deps: RunDeps): Promise<string> {
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
      queueForRun(ctx, n, depsFor(n));
      ready.push(n);
    } catch (err) {
      results.set(n, prefix(n)(`Skipped: ${(err as Error).message}`));
      failed = true;
    }
  }

  // The cap comes from the trusted config, like everything else that steers a run.
  const limit = trustedConfig(ctx.project, ctx.config, deps.run).concurrency.max_runs;
  const pending = [...ready];
  let limited = false;
  const worker = async () => {
    for (let n = pending.shift(); n !== undefined; n = pending.shift()) {
      try {
        const { message, outcome } = await driveAndReport(ctx, n, options, depsFor(n));
        if (outcome.kind === "rate_limited") limited = true;
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
async function driveAndReport(
  ctx: ServiceContext,
  number: number,
  options: { unsafe?: boolean },
  deps: RunDeps,
): Promise<{ message: string; outcome: DriveOutcome }> {
  const print = deps.print ?? console.log;
  const style = deps.style ?? plain;
  const events = new FactoryEvents();
  events.on((e) => {
    const line = formatEvent(e, style);
    if (line) print(line);
  });

  let stop: (() => void) | undefined;
  try {
    const { outcome, run } = await driveIssue(ctx, number, options, {
      run: deps.run,
      env: deps.env,
      github: deps.github,
      owner: `cli-${process.pid}`,
      events,
      onNotice: (notice) => {
        switch (notice.type) {
          case "no_checks":
            print("Warning: no checks are configured in .factory/config.yaml on the default branch; the quality gate only scans for secrets.");
            return;
          case "unsafe_ignored":
            print(`--unsafe ignored: run ${notice.runId} already exists without it.`);
            return;
          case "started":
            print(`Run ${style.detail(notice.run.id)} (${style.state(notice.run.state)}) for #${number} ${notice.issue.title}`);
            // Ctrl+C: stop this process's agent and give the lease back so the run can be continued right away.
            stop = notice.stop;
            if (interrupts.size === 0) process.once("SIGINT", onSigint);
            interrupts.add(stop);
        }
      },
    });
    return { message: describeOutcome(outcome, run, number, style), outcome };
  } finally {
    if (stop) {
      interrupts.delete(stop);
      if (interrupts.size === 0) process.off("SIGINT", onSigint);
    }
  }
}

/** `factory status`: one line per run, after finishing runs whose PR was merged or closed on GitHub. */
export function runStatus(cwd: string, options: { all?: boolean } = {}, deps: Pick<RunDeps, "run" | "style" | "github"> = {}): string {
  const style = deps.style ?? plain;
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const reconciled = reportLines(reconcileAndSweep(store, project, config, deps));
      const notes = reconciled.length ? `${reconciled.join("\n")}\n\n` : "";
      const lessons = lessonsNote(store, project);
      const footer = lessons ? `\n\n${style.attention(lessons)}` : "";
      const runs = store.listRuns({ project_id: project.id }).filter((r) => options.all || !isTerminal(r.state));
      if (runs.length === 0) return notes + (options.all ? "No runs yet." : `No active runs. ${style.hint("`factory status --all` shows finished ones.")}`) + footer;
      const header = ["RUN", "ISSUE", "STATE", "ROUND", "COST", "WAITING"];
      const rows = runs.map((r) => [
        r.id,
        r.issue_number ? `#${r.issue_number}` : "-",
        r.state,
        `b${r.build_iterations + 1} r${r.review_rounds + 1}${r.resync_rounds ? `, ${r.resync_rounds} re-sync${r.resync_rounds > 1 ? "s" : ""}` : ""}`,
        `$${runCost(store, r.id).toFixed(2)}`,
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
      ].join("\n") + footer;
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
        // Read each time: the worktree appears only once the build starts.
        const worktree = store.getRun(run.id)?.worktree_path;
        const roots = [project.repo_path, ...(worktree ? [worktree] : [])];
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
            for (const activity of applyStreamLine(emptySummary(), line, roots)) print(`[${agent.role}] ${activity}`);
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
async function continueRun(ctx: ServiceContext, run: Run, to: RunState, done: string, options: { run?: boolean }, deps: RunDeps): Promise<string> {
  const next = continuation(ctx.store, ctx.project, run, to);
  if (next === "ended") return done;
  // Set: continuation says "ended" for a run without an issue.
  const issue = run.issue_number!;
  if (options.run === false) return `${done}\nContinue with \`factory run ${issue}\`.`;
  if (next === "not_queued") {
    return `${done}\nIssue #${issue} is no longer queued, so the run was not continued. \`factory run ${issue}\` queues it again and continues.`;
  }
  (deps.print ?? console.log)(done);
  return (await driveAndReport(ctx, issue, {}, deps)).message;
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
    async (ctx) => {
      const { run, gate, to } = approveRun(ctx, ref, options, deps.run);
      const done = `Approved the ${gate} gate of ${run.id}; it moves to ${to}.`;
      return continueRun(ctx, run, to, done, options, deps);
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
    async (ctx) => {
      const { run, to } = resumeRun(ctx, ref, options, deps.run);
      const loops = options.resetLoops ? " with a fresh loop budget" : "";
      return continueRun(ctx, run, to, `Resumed ${run.id} to ${to}${loops}.`, options, deps);
    },
    deps.run,
  );
}

/** A line for the command's output about the run's screenshots release, or "" when it had none. */
function describeMedia(media: DroppedMedia | undefined): string {
  if (!media) return "";
  if (media.error === undefined) return `\nDeleted its screenshots release ${media.tag}.`;
  return `\nCould not delete its screenshots release (${media.error}); delete it with \`gh release delete ${media.tag}\`.`;
}

/** `factory reject <run> -m <why>`: end a run waiting at a gate. */
export function runReject(cwd: string, ref: string, options: { message: string }, run?: CommandRunner): string {
  return withProject(
    cwd,
    (ctx) => {
      const rejected = rejectRun(ctx, ref, options, run);
      const cleaned = rejected.cleaned.map((l) => `\n${l}`).join("");
      return `Rejected ${rejected.run.id} at the ${rejected.gate} gate.${describeMedia(rejected.media)}${cleaned}`;
    },
    run,
  );
}

/**
 * `factory cancel <run>`: stop its agent (and everything the agent started) and end the run. Its
 * worktree and branch are cleaned up now when no worker drives it, or else by the worker once it stopped.
 */
export function runCancel(cwd: string, ref: string, options: { message?: string }, run?: CommandRunner): string {
  return withProject(
    cwd,
    (ctx) => {
      const cancelled = cancelRun(ctx, ref, options.message?.trim() || "cancelled from the CLI", run);
      const { stopped: count } = cancelled;
      const stopped = count ? ` Stopped ${count} agent process${count > 1 ? "es" : ""}.` : "";
      return `Cancelled ${cancelled.run.id}.${stopped}${describeMedia(cancelled.media)}${cancelled.cleaned.map((l) => `\n${l}`).join("")}`;
    },
    run,
  );
}
