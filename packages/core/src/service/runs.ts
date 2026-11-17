import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isTerminal, isTrustedIssue, STAGES, type FactoryConfig, type Gate, type RunState } from "@factory/shared";
import { createAgentRunner } from "../agents/runner.js";
import { loadTrustedConfig, trustedReader } from "../config/trusted.js";
import type { FactoryEvents } from "../events.js";
import { fetchIssue } from "../github/issues.js";
import { deleteMedia, MEDIA_MARKER, mediaTag } from "../github/media.js";
import { ghPort, type GithubPort } from "../github/port.js";
import { approveTarget, nextAfterTriage, PipelineDriver, runDirOf, waitingCommit, type DriveOutcome } from "../pipeline/driver.js";
import { resumeTargets, RunMachine } from "../pipeline/transitions.js";
import { fetchedFromGithub, type Issue, type Project, type Run, type Store } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { killTree } from "../util/process.js";
import { ServiceError } from "./errors.js";
import { cleanUpNow } from "./reconcile.js";

/** The repo a run action works on: its store, its project row and the working-copy config. */
export interface ServiceContext {
  store: Store;
  project: Project;
  config: FactoryConfig;
}

export interface ServiceDeps {
  run?: CommandRunner;
  github?: GithubPort;
}

function parseIssueNumber(value: string): number {
  const n = Number(value.replace(/^#/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new ServiceError(`"${value}" is not an issue number`);
  return n;
}

/** A run by full id, unique id prefix, or `#<issue>` (that issue's latest run). */
export function findRun(store: Store, project: Project, ref: string): Run {
  const runs = store.listRuns({ project_id: project.id });
  if (/^#?\d+$/.test(ref)) {
    const issue = parseIssueNumber(ref);
    const latest = runs.find((r) => r.issue_number === issue);
    if (!latest) throw new ServiceError(`No run for issue #${issue}.`);
    return latest;
  }
  const matches = runs.filter((r) => r.id === ref || r.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  const exact = matches.find((r) => r.id === ref);
  if (exact) return exact;
  throw new ServiceError(matches.length ? `"${ref}" matches several runs; use more of the id.` : `No run "${ref}". See \`factory status\`.`);
}

/** What the agents of a run have cost so far, in USD. */
export function runCost(store: Store, runId: string): number {
  return store.listAgentRuns(runId).reduce((sum, a) => sum + (a.cost_usd ?? 0), 0);
}

/**
 * The config from the default branch, as a run uses it. A human's decision at a gate is applied
 * by these rules too, so a local edit cannot change where an approved run goes next.
 */
export function trustedConfig(project: Project, workingConfig: FactoryConfig, run?: CommandRunner): FactoryConfig {
  const defaultBranch = workingConfig.project.default_branch;
  return loadTrustedConfig(trustedReader(project.repo_path, defaultBranch, run), defaultBranch);
}

export interface QueuedIssue {
  issue: Issue;
  /** Queued just now, rather than already queued before. */
  queued: boolean;
  /** Its author is in `trust.authors`. */
  trusted: boolean;
}

/**
 * Make sure the issue is synced and queued. Asking to run an issue is itself the local decision to
 * work on it, so it queues the issue the same way `factory queue <n>` would; nobody on GitHub can
 * trigger this.
 */
export function ensureQueued(ctx: ServiceContext, number: number, run?: CommandRunner): QueuedIssue {
  const { store, project, config } = ctx;
  const known = store.getIssue(project.id, number);
  // One `factory import` queued but GitHub never filled in, or with a factory claim from the file
  // still to settle, is fetched like an unqueued one: until then its trust would rest on the file.
  const fromImport = known !== undefined && (!fetchedFromGithub(known) || store.pendingFactoryClaims(project.id, [number]).length > 0);
  if (known?.queued_at && !fromImport) return { issue: known, queued: false, trusted: isTrustedIssue(config, known) };
  // Fetch fresh before queueing: the local copy may be missing, or stale since the last sync
  // (closed or edited on GitHub), and this is about to start agents on it.
  try {
    fetchIssue(store, project, number, run);
  } catch (err) {
    throw new ServiceError(`Could not fetch issue #${number}: ${(err as Error).message}`);
  }
  const issue = store.getIssue(project.id, number)!;
  if (issue.state !== "open") throw new ServiceError(`Issue #${number} is closed.`);
  const queued = issue.queued_at === null;
  store.setQueued(project.id, number, true);
  return { issue: store.getIssue(project.id, number)!, queued, trusted: isTrustedIssue(config, issue) };
}

/** What driveIssue reports before the run moves, in this order. */
export type DriveNotice =
  /** The trusted config has no checks, so the quality gate only scans for secrets. */
  | { type: "no_checks" }
  /** `unsafe` was asked for, but the run already existed without it. */
  | { type: "unsafe_ignored"; runId: string }
  /**
   * The run is about to be driven. `stop` kills its running agents and gives the lease back, so
   * the run can be continued right away (e.g. on Ctrl+C); it is only valid until driveIssue returns.
   */
  | { type: "started"; run: Run; issue: Issue; stop: () => void };

export interface DriveDeps extends ServiceDeps {
  /** Lease owner name for this process. */
  owner: string;
  /** Environment for agents (tests point FACTORY_CLAUDE_BIN at the fake). */
  env?: NodeJS.ProcessEnv;
  /** Progress of the run: state changes, agents, checks. */
  events?: FactoryEvents;
  onNotice?: (notice: DriveNotice) => void;
}

export interface DriveOptions {
  /** Lift hard rules for a run this creates (`--unsafe`). */
  unsafe?: boolean;
  /**
   * Continue exactly this run. If it has ended or moved out of a working stage since it was picked,
   * nothing is driven and no new run is created: a scheduler picked it, not a person.
   */
  runId?: string;
  /** Send a run waiting for its author's answers back to triage (default). `factory run` means "they answered"; a scheduler can't know. */
  retriage?: boolean;
}

export interface Driven {
  outcome: DriveOutcome;
  /** The run as it is after driving. */
  run: Run;
}

/** Drive a queued issue's run (starting one if needed) until it needs someone. */
export async function driveIssue(ctx: ServiceContext, number: number, options: DriveOptions, deps: DriveDeps): Promise<Driven> {
  const { store, project } = ctx;
  const issue = store.getIssue(project.id, number)!;
  const defaultBranch = ctx.config.project.default_branch;
  const read = trustedReader(project.repo_path, defaultBranch, deps.run);
  const config = loadTrustedConfig(read, defaultBranch);
  const { owner, events } = deps;
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

  if (config.checks.length === 0) deps.onNotice?.({ type: "no_checks" });
  let run: Run;
  if (options.runId) {
    const picked = store.getRun(options.runId);
    if (!picked || picked.issue_number !== number) throw new ServiceError(`Run ${options.runId} is not a run of issue #${number}.`);
    if (!(STAGES as readonly string[]).includes(picked.state)) {
      return { outcome: { kind: "stopped", state: picked.state, reason: `the run is ${picked.state} now, not in a working stage` }, run: picked };
    }
    run = picked;
  } else {
    run = driver.startRun(number, { unsafe: options.unsafe });
  }
  if (options.unsafe && !run.unsafe) deps.onNotice?.({ type: "unsafe_ignored", runId: run.id });
  // Running an issue that was waiting for its author means "they answered": triage it again.
  if (run.state === "needs_info" && options.retriage !== false) run = driver.retriage(run.id);

  // Only rows still running are ours: this process holds the run's lease.
  const stop = () => {
    for (const agent of store.listAgentRuns(run.id)) {
      if (agent.status !== "running") continue;
      if (agent.pid) killTree(agent.pid);
      store.finishAgentRun(agent.id, { status: "cancelled" });
    }
    store.releaseLease(run.id, owner);
  };
  deps.onNotice?.({ type: "started", run, issue, stop });
  const outcome = await driver.drive(run.id);
  return { outcome, run: store.getRun(run.id)! };
}

/**
 * Whether a run a human just sent on to `to` can be driven further now: not when it ended or has
 * no issue, and not when its issue is no longer queued. Not re-queued here: the issue may have
 * been unqueued on purpose, or closed on GitHub since.
 */
export function continuation(store: Store, project: Project, run: Run, to: RunState): "ended" | "not_queued" | "ready" {
  if (isTerminal(to) || run.issue_number === null) return "ended";
  if (!store.getIssue(project.id, run.issue_number)?.queued_at) return "not_queued";
  return "ready";
}

export interface Approved {
  /** The run as it is after the move. */
  run: Run;
  /** The gate it was waiting at. */
  gate: Gate;
  to: RunState;
}

/** Let a run waiting at a gate continue to where the gate leads. */
export function approveRun(ctx: ServiceContext, ref: string, options: { message?: string }, run?: CommandRunner): Approved {
  const { store, project } = ctx;
  const target = findRun(store, project, ref);
  if (target.state !== "needs_human" || !target.waiting_gate) {
    throw new ServiceError(`Run ${target.id} is not waiting at a gate (it is ${target.state}).`);
  }
  const trusted = trustedConfig(project, ctx.config, run);
  // An approved triage goes where it would have gone on its own: refine, the spec critic or build.
  const to = approveTarget(target, nextAfterTriage(runDirOf(project.repo_path, target.id), trusted));
  if (!to) throw new ServiceError(`Approving the ${target.waiting_gate} gate is not supported yet.`);
  const gate = target.waiting_gate;
  // A merge approval is for the commit that was waiting, so a later change cannot ride on it.
  const commitSha = gate === "merge" ? waitingCommit(store.listEvents(target.id)) : undefined;
  new RunMachine(store, trusted).resume(target.id, to, { comment: options.message?.trim() || "approved", commitSha });
  return { run: store.getRun(target.id)!, gate, to };
}

/**
 * Send a run parked for a human (an escalation such as a failed agent or the build cap) back to an
 * earlier stage or one step onward.
 */
export function resumeRun(
  ctx: ServiceContext,
  ref: string,
  options: { to: string; message: string; resetLoops?: boolean },
  run?: CommandRunner,
): { run: Run; to: RunState } {
  const { store, project } = ctx;
  if (!options.message?.trim()) throw new ServiceError("Say why with -m.");
  const target = findRun(store, project, ref);
  if (target.state !== "needs_human") throw new ServiceError(`Run ${target.id} is not waiting for you (it is ${target.state}).`);
  const allowed = resumeTargets(target);
  if (!allowed.includes(options.to as RunState)) {
    throw new ServiceError(`Run ${target.id} can resume to: ${allowed.join(", ")}.`);
  }
  const to = options.to as RunState;
  new RunMachine(store, trustedConfig(project, ctx.config, run)).resume(target.id, to, { comment: options.message, resetLoops: options.resetLoops });
  return { run: store.getRun(target.id)!, to };
}

/** What happened to the screenshots release of a run that ended. */
export interface DroppedMedia {
  tag: string;
  /** Set when it could not be deleted: the first line of why. */
  error?: string;
}

/**
 * Best effort: a run that ends without being merged takes its screenshots release (a draft, see
 * uploadMedia) with it. Undefined when it had none.
 */
export function dropMedia(project: Project, runId: string, run?: CommandRunner): DroppedMedia | undefined {
  const marker = join(runDirOf(project.repo_path, runId), MEDIA_MARKER);
  if (!existsSync(marker)) return undefined;
  try {
    deleteMedia(project, runId, run);
    rmSync(marker);
    return { tag: mediaTag(runId) };
  } catch (err) {
    return { tag: mediaTag(runId), error: (err as Error).message.split("\n")[0] };
  }
}

export interface Ended {
  /** The run as it is after it ended. */
  run: Run;
  media?: DroppedMedia;
  /** Lines about the cleanup of its worktree and branch (see cleanUpNow). */
  cleaned: string[];
}

/** End a run waiting at a gate. */
export function rejectRun(ctx: ServiceContext, ref: string, options: { message: string }, run?: CommandRunner): Ended & { gate: Gate } {
  const { store, project, config } = ctx;
  if (!options.message?.trim()) throw new ServiceError("Say why with -m.");
  const target = findRun(store, project, ref);
  if (target.state !== "needs_human" || !target.waiting_gate) {
    throw new ServiceError(`Run ${target.id} is not waiting at a gate (it is ${target.state}).`);
  }
  new RunMachine(store, trustedConfig(project, config, run)).resume(target.id, "rejected", { comment: options.message });
  // A run waiting at a gate has no worker, so nothing runs in its worktree.
  const cleaned = cleanUpNow(store, project, config, target.id, run);
  const media = dropMedia(project, target.id, run);
  return { run: store.getRun(target.id)!, gate: target.waiting_gate, media, cleaned };
}

/**
 * Stop a run's agent (and everything the agent started) and end the run. Its worktree and branch
 * are cleaned up now when no worker drives it, or else by the worker once it stopped.
 * When the run's issue was closed on GitHub, its open PR is closed first, with its branch: the work
 * was done elsewhere or is not wanted (see reconcileWithGithub, which leaves that call to a human).
 * If GitHub refuses, nothing changes and this throws, so no cancelled run is left with an open PR.
 */
export function cancelRun(ctx: ServiceContext, ref: string, reason: string, deps: ServiceDeps = {}): Ended & { stopped: number; closedPr?: number } {
  const { store, project, config } = ctx;
  const { run } = deps;
  const target = findRun(store, project, ref);
  if (isTerminal(target.state)) throw new ServiceError(`Run ${target.id} is already ${target.state}.`);
  const closedPr = closeStalePullRequest(ctx, target, deps);
  // A pid is only trusted while a worker holds the lease: after a crash the agent row can
  // still say "running" and its pid may since belong to an unrelated process.
  const driven = target.lease_expires_at !== null && target.lease_expires_at > new Date().toISOString();
  const running = driven ? store.listAgentRuns(target.id).filter((a) => a.status === "running" && a.pid) : [];
  for (const agent of running) killTree(agent.pid!);
  new RunMachine(store, config).cancel(target.id, reason);
  // A driven run's worker may still be stopping in the worktree; it cleans up once it has.
  const cleaned = driven ? [] : cleanUpNow(store, project, config, target.id, run);
  const media = dropMedia(project, target.id, run);
  return { run: store.getRun(target.id)!, stopped: running.length, media, cleaned, ...(closedPr !== undefined ? { closedPr } : {}) };
}

/** Close the PR of a run whose issue was closed on GitHub, if it is still open; its number when it did. */
function closeStalePullRequest(ctx: ServiceContext, target: Run, deps: ServiceDeps): number | undefined {
  const { store, project } = ctx;
  if (target.pr_number === null || target.issue_number === null) return undefined;
  if (store.getIssue(project.id, target.issue_number)?.state !== "closed") return undefined;
  const number = target.pr_number;
  try {
    const github = deps.github ?? ghPort(project, deps.run);
    // The stored state can be stale (reopened since): only GitHub's word closes a PR.
    if (github.issueState(target.issue_number).state === "open") {
      store.reopenIssue(project.id, target.issue_number);
      return undefined;
    }
    if (github.pullRequestState(number).state !== "open") return undefined;
    github.closePullRequest(number, `Issue #${target.issue_number} was closed on GitHub, so the factory's run for it was cancelled.`);
    return number;
  } catch (err) {
    // Cancelling anyway would hide the open PR: nothing points at it any more.
    throw new ServiceError(
      `Run ${target.id} was not cancelled: closing PR #${number} failed: ${(err as Error).message.split("\n")[0]}\nClose the PR on GitHub, and the next sync cancels the run.`,
    );
  }
}
