import { existsSync, readFileSync } from "node:fs";
import {
  APPROVE_TARGET,
  applyStreamLine,
  createAgentRunner,
  emptySummary,
  FactoryEvents,
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
  type Project,
  type Run,
  type Store,
} from "@factory/core";
import { isTerminal, type RunState } from "@factory/shared";
import { CliError, withProject, withProjectAsync } from "../context.js";

export interface RunDeps {
  run?: CommandRunner;
  /** Environment for agents (tests point FACTORY_CLAUDE_BIN at the fake). */
  env?: NodeJS.ProcessEnv;
  github?: GithubPort;
  print?: (line: string) => void;
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

function formatEvent(event: FactoryEvent): string | undefined {
  switch (event.type) {
    case "run:state":
      return `-> ${event.to}: ${event.reason}`;
    case "agent:start":
      return `[${event.role}] ${event.resumed ? "resuming" : "starting"} agent ${event.agentRunId}`;
    case "agent:activity":
      return `    ${event.summary}`;
    case "agent:end":
      return `[${event.role}] ${event.status}${event.costUsd != null ? ` ($${event.costUsd.toFixed(2)})` : ""}`;
    case "gate:check":
      return `[gate] ${event.name}: ${event.passed ? "passed" : "FAILED"} (${(event.durationMs / 1000).toFixed(1)}s)`;
    case "info":
      return `    ${event.message}`;
  }
}

function describeOutcome(outcome: DriveOutcome, run: Run, issue: number): string {
  switch (outcome.kind) {
    case "parked":
      if (outcome.state === "needs_info") return `Run ${run.id} is waiting for answers on issue #${issue}.`;
      return run.waiting_gate
        ? [
            `Run ${run.id} is waiting at the ${run.waiting_gate} gate: ${outcome.reason}`,
            `Approve with \`factory approve ${run.id}\`, or reject with \`factory reject ${run.id} -m "<why>"\`.`,
          ].join("\n")
        : [
            `Run ${run.id} needs you: ${outcome.reason}`,
            `See \`factory logs ${run.id}\`. Send it on with \`factory resume ${run.id} --to <stage> -m "<why>"\`, or stop it with \`factory cancel ${run.id}\`.`,
          ].join("\n");
    case "finished":
      return `Run ${run.id} finished: ${outcome.state}.`;
    case "rate_limited":
      return `Usage limit reached${outcome.resetsAt ? ` (resets ${outcome.resetsAt})` : ""}. Run \`factory run ${issue}\` again after that; the run continues where it stopped.`;
    case "stopped":
      return `Run ${run.id} stopped in ${outcome.state}: ${outcome.reason}`;
  }
}

/** `factory run <issue>`: start (or continue) the issue's run and drive it until it needs someone. */
export async function runRun(cwd: string, value: string, options: { unsafe?: boolean }, deps: RunDeps = {}): Promise<string> {
  const number = parseIssueNumber(value);
  const print = deps.print ?? console.log;
  return withProjectAsync(
    cwd,
    async ({ store, project, config: workingConfig }) => {
      const issue = store.getIssue(project.id, number);
      if (!issue?.queued_at) {
        throw new CliError(`Issue #${number} is not queued. Queue it first with \`factory queue ${number}\`.`);
      }
      const defaultBranch = workingConfig.project.default_branch;
      const read = trustedReader(project.repo_path, defaultBranch, deps.run);
      const config = loadTrustedConfig(read, defaultBranch);

      const events = new FactoryEvents();
      events.on((e) => {
        const line = formatEvent(e);
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
      print(`Run ${run.id} (${run.state}) for #${number} ${issue.title}`);

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
        return describeOutcome(outcome, store.getRun(run.id)!, number);
      } finally {
        process.off("SIGINT", onInterrupt);
      }
    },
    deps.run,
  );
}

function cost(store: Store, runId: string): number {
  return store.listAgentRuns(runId).reduce((sum, a) => sum + (a.cost_usd ?? 0), 0);
}

/** `factory status`: one line per run. */
export function runStatus(cwd: string, options: { all?: boolean } = {}, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project }) => {
      const runs = store.listRuns({ project_id: project.id }).filter((r) => options.all || !isTerminal(r.state));
      if (runs.length === 0) return options.all ? "No runs yet." : "No active runs. `factory status --all` shows finished ones.";
      const rows = [
        ["RUN", "ISSUE", "STATE", "ROUND", "COST", "WAITING"],
        ...runs.map((r) => [
          r.id,
          r.issue_number ? `#${r.issue_number}` : "-",
          r.state,
          `b${r.build_iterations + 1} r${r.review_rounds + 1}`,
          `$${cost(store, r.id).toFixed(2)}`,
          r.waiting_gate ?? "",
        ]),
      ];
      const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
      return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
    },
    run,
  );
}

function renderLogs(store: Store, runId: string): string[] {
  const lines = store.listEvents(runId).map((e) => `${e.created_at}  ${e.from_state ?? "-"} -> ${e.to_state}  ${e.reason}`);
  for (const agent of store.listAgentRuns(runId)) {
    lines.push(
      "",
      `agent ${agent.id} ${agent.role} ${agent.status}${agent.cost_usd != null ? ` $${agent.cost_usd.toFixed(2)}` : ""}  log: ${agent.log_path}`,
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
  deps: { run?: CommandRunner; print?: (line: string) => void } = {},
): Promise<string> {
  const print = deps.print ?? console.log;
  return withProjectAsync(
    cwd,
    async ({ store, project }) => {
      const run = findRun(store, project, ref);
      if (!options.follow) return renderLogs(store, run.id).join("\n");

      let events = 0;
      const offsets = new Map<string, number>();
      for (;;) {
        for (const e of store.listEvents(run.id).slice(events)) {
          print(`-> ${e.to_state}: ${e.reason}`);
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
          return `Run ${run.id} is ${current.state}.`;
        }
        await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
      }
    },
    deps.run,
  );
}

/** `factory approve <run>`: let a run waiting at a gate continue. */
export function runApprove(cwd: string, ref: string, options: { message?: string }, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const target = findRun(store, project, ref);
      if (target.state !== "needs_human" || !target.waiting_gate) {
        throw new CliError(`Run ${target.id} is not waiting at a gate (it is ${target.state}).`);
      }
      const to = APPROVE_TARGET[target.waiting_gate];
      if (!to) throw new CliError(`Approving the ${target.waiting_gate} gate is not supported yet.`);
      const gate = target.waiting_gate;
      new RunMachine(store, config).resume(target.id, to, { comment: options.message?.trim() || "approved" });
      const next =
        gate === "review"
          ? "Reviews are not automated yet: review the draft PR, then mark it ready and merge it yourself."
          : `Continue with \`factory run ${target.issue_number}\`.`;
      return `Approved the ${gate} gate of ${target.id}; it moves to ${to}.\n${next}`;
    },
    run,
  );
}

/**
 * `factory resume <run> --to <stage> -m <why>`: send a run parked for a human (an escalation such
 * as a failed agent or the build cap) back to an earlier stage or one step onward.
 */
export function runResume(
  cwd: string,
  ref: string,
  options: { to: string; message: string; resetLoops?: boolean },
  run?: CommandRunner,
): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      if (!options.message?.trim()) throw new CliError("Say why with -m.");
      const target = findRun(store, project, ref);
      if (target.state !== "needs_human") throw new CliError(`Run ${target.id} is not waiting for you (it is ${target.state}).`);
      const allowed = resumeTargets(target);
      if (!allowed.includes(options.to as RunState)) {
        throw new CliError(`Run ${target.id} can resume to: ${allowed.join(", ")}.`);
      }
      new RunMachine(store, config).resume(target.id, options.to as RunState, {
        comment: options.message,
        resetLoops: options.resetLoops,
      });
      const loops = options.resetLoops ? " with a fresh loop budget" : "";
      const next = isTerminal(options.to as RunState) ? "" : `\nContinue with \`factory run ${target.issue_number}\`.`;
      return `Resumed ${target.id} to ${options.to}${loops}.${next}`;
    },
    run,
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
