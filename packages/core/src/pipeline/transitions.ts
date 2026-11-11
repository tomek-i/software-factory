import {
  STAGES,
  isTerminal,
  type FactoryConfig,
  type ParsedVerdict,
  type RunState,
  type Stage,
  type VerdictKind,
} from "@factory/shared";
import type { PullRequestState } from "../github/port.js";
import type { Run, RunEvent, RunPatch, StatePatch, Store } from "../store/store.js";
import { findingsFingerprint } from "./fingerprint.js";

/**
 * Forward edges of the pipeline. Every non-terminal state may additionally move to needs_human,
 * failed or cancelled. Leaving needs_human is only possible through RunMachine.resume (a human).
 */
const FORWARD: Partial<Record<RunState, readonly RunState[]>> = {
  intake: ["triage"],
  // triage -> build skips refine and the spec critic, which do not exist yet (phase 3).
  triage: ["refine", "critic", "build", "rejected", "needs_info"],
  refine: ["critic", "needs_info"],
  critic: ["refine", "build", "rejected"],
  build: ["gate"],
  gate: ["review", "build"],
  review: ["build", "capture"],
  capture: ["pr"],
  pr: ["merge"],
  merge: ["learn", "build"],
  learn: ["done"],
  needs_info: ["triage", "rejected"],
};

const ALWAYS_ALLOWED: readonly RunState[] = ["needs_human", "failed", "cancelled"];

/** Targets reachable with RunMachine.transition (automatic moves). */
export function allowedTargets(from: RunState): RunState[] {
  if (isTerminal(from) || from === "needs_human") return [];
  return [...(FORWARD[from] ?? []), ...ALWAYS_ALLOWED];
}

/**
 * Stages a human may resume a parked run into: back to any stage up to where it was parked, or
 * onward along one of that stage's own edges. That lets a human approve a gate (move on) or send
 * work back, but never jump over stages.
 */
export function resumeTargets(run: Pick<Run, "parked_from">): RunState[] {
  const parked = run.parked_from && STAGES.includes(run.parked_from as Stage) ? (run.parked_from as Stage) : "intake";
  const back = STAGES.slice(0, STAGES.indexOf(parked) + 1);
  const onward = (FORWARD[parked] ?? []).filter((s) => STAGES.includes(s as Stage));
  return [...new Set<RunState>([...back, ...onward, "rejected", "cancelled"])];
}

/** Facts about the run's worktree and output files, injected so guards stay testable. */
export interface Evidence {
  verdict<K extends VerdictKind>(kind: K): ParsedVerdict<K>;
  /** Review verdicts of the current round, one per lens. */
  reviews(): ParsedVerdict<"review">[];
  /**
   * Fingerprint of this round's quality-gate failure (gateFingerprint). Without it a failed gate
   * still loops, but stalls cannot be detected.
   */
  gateFingerprint?(): string;
  git: {
    head(): string;
    isClean(): boolean;
    commitsAhead(): number;
    isPushed(): boolean;
  };
}

interface GuardContext {
  run: Run;
  config: FactoryConfig;
  evidence: Evidence;
}

type Guard = (ctx: GuardContext) => string[];

/**
 * Loop caps count total attempts: max_build_iterations 5 means at most 5 builds (the first plus
 * 4 rebuilds). The counters store how many times the loop has gone round again.
 */
function capProblem(again: number, max: number, what: string): string[] {
  return again + 1 >= max ? [`${what} cap reached (${max})`] : [];
}

function cleanAndPushed(evidence: Evidence): string[] {
  const problems: string[] = [];
  if (!evidence.git.isClean()) problems.push("worktree has uncommitted changes");
  if (!evidence.git.isPushed()) problems.push("branch is not pushed to origin");
  return problems;
}

function checksOnHead(evidence: Evidence, expected: "PASS" | "FAIL"): string[] {
  const checks = evidence.verdict("checks").header;
  const problems: string[] = [];
  if (checks.GATE !== expected) problems.push(`quality gate result is ${checks.GATE}, expected ${expected}`);
  const head = evidence.git.head();
  if (checks.COMMIT !== head) problems.push(`gate ran on ${checks.COMMIT.slice(0, 7)} but HEAD is ${head.slice(0, 7)}`);
  return problems;
}

/** Reviews are done when every lens passed, or the verifier refuted every blocking finding. */
function reviewsClear(evidence: Evidence): string[] {
  const reviews = evidence.reviews();
  if (reviews.length === 0) return ["no review results for this round"];
  if (reviews.every((r) => r.header.VERDICT === "PASS")) return [];
  return evidence.verdict("verify").header.VERDICT === "NONE_CONFIRMED"
    ? []
    : ["reviews requested changes and the verifier confirmed findings"];
}

/** Evidence each automatic edge must show. Returns problems; empty means allowed. */
const GUARDS: Partial<Record<`${RunState}->${RunState}`, Guard>> = {
  "triage->refine": ({ evidence }) => triageApproved(evidence),
  "triage->critic": ({ evidence }) => triageApproved(evidence),
  "triage->build": ({ evidence }) => triageApproved(evidence),
  "critic->build": ({ evidence }) =>
    evidence.verdict("critic").header.VERDICT === "ACCEPT" ? [] : ["spec critic did not ACCEPT"],
  "critic->refine": ({ run, config, evidence }) => [
    ...(evidence.verdict("critic").header.VERDICT === "REVISE" ? [] : ["spec critic did not ask to REVISE"]),
    ...capProblem(run.critic_rounds, config.loops.max_critic_rounds, "spec critic round"),
  ],
  "build->gate": ({ evidence }) => {
    const build = evidence.verdict("build").header;
    const problems: string[] = [];
    if (build.STATUS !== "READY") problems.push("builder did not report STATUS: READY");
    if (build.COMMIT !== evidence.git.head()) problems.push("builder's report is for a different commit than HEAD");
    if (evidence.git.commitsAhead() < 1) problems.push("branch has no commits ahead of the base branch");
    return [...problems, ...cleanAndPushed(evidence)];
  },
  "gate->review": ({ evidence }) => [...checksOnHead(evidence, "PASS"), ...cleanAndPushed(evidence)],
  "gate->build": ({ run, config, evidence }) => [
    ...checksOnHead(evidence, "FAIL"),
    ...capProblem(run.build_iterations, config.loops.max_build_iterations, "build iteration"),
  ],
  "review->build": ({ run, config, evidence }) => [
    ...(evidence.verdict("verify").header.VERDICT === "CONFIRMED" ? [] : ["no confirmed findings to fix"]),
    ...capProblem(run.review_rounds, config.loops.max_review_rounds, "review round"),
  ],
  // Reviews must be clear and must have looked at exactly the commit that passed the gate.
  "review->capture": ({ evidence }) => [
    ...reviewsClear(evidence),
    ...checksOnHead(evidence, "PASS"),
    ...cleanAndPushed(evidence),
  ],
  // A failed merge attempt (conflict, failing re-gate) costs a review round so the loop is bounded.
  "merge->build": ({ run, config }) => capProblem(run.review_rounds, config.loops.max_review_rounds, "review round"),
};

type Edge = `${RunState}->${RunState}`;

/** A loop edge that sends work back to the builder, and how to tell one failure from another. */
interface LoopSpec {
  /** Names the repeated failure, e.g. "quality gate failed the same way in rounds 2 and 3". */
  describe: (rounds: string) => string;
  /** Output file of a round, relative to the run folder. */
  file: (round: number) => string;
  /** The round that just failed (the move bumps the counter). */
  round: (run: Run) => number;
  fingerprint: (evidence: Evidence) => string | undefined;
}

const LOOPS: Partial<Record<Edge, LoopSpec>> = {
  "gate->build": {
    describe: (rounds) => `quality gate failed the same way in rounds ${rounds}`,
    file: (round) => `round-${round}/checks.md`,
    round: (run) => run.round,
    fingerprint: (evidence) => evidence.gateFingerprint?.(),
  },
  "review->build": {
    describe: (rounds) => `the verifier confirmed the same findings in review rounds ${rounds}`,
    file: (round) => `round-${round}/verify.md`,
    round: (run) => run.round,
    fingerprint: (evidence) => findingsFingerprint(evidence.verdict("verify").findings),
  },
};

interface LoopFailure {
  fingerprint: string;
  round: number;
}

/** A loop that failed the same way twice in a row. */
export interface Stall {
  edge: Edge;
  fingerprint: string;
  rounds: [number, number];
  /** Both rounds' output files, relative to the run folder. */
  files: [string, string];
  /** "stalled: ..." naming both rounds; also the problem the refused move reports. */
  reason: string;
}

/** This round's failure on a loop edge; undefined when it cannot be fingerprinted (no stall check then). */
function loopFailure(spec: LoopSpec, run: Run, evidence: Evidence): LoopFailure | undefined {
  try {
    const fingerprint = spec.fingerprint(evidence);
    return fingerprint === undefined ? undefined : { fingerprint, round: spec.round(run) };
  } catch {
    return undefined; // the guard already reports evidence it cannot read
  }
}

/**
 * The failure the builder was last sent back with, if it came through the same loop edge. Walking
 * back, a human resume or any other way back to build ends the search: "in a row" means the builder
 * got the same failure twice with nothing else in between.
 */
function previousFailure(events: RunEvent[], edge: Edge): LoopFailure | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.from_state === "needs_human") return undefined;
    if (event.to_state !== "build") continue;
    if (`${event.from_state}->${event.to_state}` !== edge) return undefined;
    const data = event.data as { fingerprint?: unknown; round?: unknown } | null;
    return typeof data?.fingerprint === "string" && typeof data.round === "number"
      ? { fingerprint: data.fingerprint, round: data.round }
      : undefined;
  }
  return undefined;
}

function stallOf(events: RunEvent[], edge: Edge, spec: LoopSpec, current: LoopFailure): Stall | undefined {
  const previous = previousFailure(events, edge);
  if (!previous || previous.fingerprint !== current.fingerprint) return undefined;
  const rounds: [number, number] = [previous.round, current.round];
  const files: [string, string] = [spec.file(previous.round), spec.file(current.round)];
  return {
    edge,
    fingerprint: current.fingerprint,
    rounds,
    files,
    reason: `stalled: ${spec.describe(`${rounds[0]} and ${rounds[1]}`)} (see ${files[0]} and ${files[1]})`,
  };
}

/** Event data of a loop move: the caller's data plus the failure's fingerprint and round. */
function withLoopData(data: unknown, loop: LoopFailure): unknown {
  if (data === undefined || data === null) return { ...loop };
  if (typeof data === "object" && !Array.isArray(data)) return { ...data, ...loop };
  return { data, ...loop };
}

function triageApproved(evidence: Evidence): string[] {
  return evidence.verdict("triage").header.DECISION === "APPROVE" ? [] : ["triage did not APPROVE"];
}

/** Counters bumped when a loop goes round again. Always applied after any caller patch. */
function loopPatch(run: Run, from: RunState, to: RunState): StatePatch {
  if (to === "gate") return { round: run.round + 1 };
  if (from === "gate" && to === "build") return { build_iterations: run.build_iterations + 1 };
  if ((from === "review" || from === "merge") && to === "build") return { review_rounds: run.review_rounds + 1 };
  if (from === "critic" && to === "refine") return { critic_rounds: run.critic_rounds + 1 };
  return {};
}

export class TransitionError extends Error {
  constructor(
    readonly runId: string,
    readonly from: RunState,
    readonly to: RunState,
    readonly problems: string[],
    /** Set when the move was refused because the loop failed the same way twice in a row. */
    readonly stall?: Stall,
  ) {
    super(`cannot move ${runId} from ${from} to ${to}: ${problems.join("; ")}`);
    this.name = "TransitionError";
  }
}

export interface TransitionOptions {
  reason: string;
  evidence?: Evidence;
  data?: unknown;
  patch?: RunPatch;
  /** Worker holding the run's lease. Required when the run is leased. */
  owner?: string;
}

export interface ResumeOptions {
  /** Why the human made this call. Required, and stored as a decision. */
  comment: string;
  /** Give the loops a fresh budget (the human is granting more attempts). */
  resetLoops?: boolean;
  owner?: string;
  commitSha?: string;
}

/**
 * The only code allowed to change a run's state.
 *
 * Evidence is gathered before the write (it shells out to git), then the state change is a
 * compare-and-set inside an IMMEDIATE transaction: if another writer moved the run in the
 * meantime, the change is refused instead of being applied on stale facts.
 */
export class RunMachine {
  constructor(
    private readonly store: Store,
    private readonly config: FactoryConfig,
  ) {}

  /** Automatic move along a pipeline edge, guarded by evidence. */
  transition(runId: string, to: RunState, options: TransitionOptions): Run {
    const run = this.load(runId);
    const from = run.state;
    this.checkLease(run, to, options.owner);

    if (from === "needs_human") {
      throw new TransitionError(runId, from, to, ["a parked run can only be resumed by a human (RunMachine.resume)"]);
    }
    if (!allowedTargets(from).includes(to)) {
      throw new TransitionError(runId, from, to, [`no edge from ${from} to ${to}`]);
    }

    const edge: Edge = `${from}->${to}`;
    const guard = GUARDS[edge];
    let loop: LoopFailure | undefined;
    if (guard) {
      if (!options.evidence) throw new TransitionError(runId, from, to, ["evidence is required for this move"]);
      const problems = runGuard(guard, { run, config: this.config, evidence: options.evidence });
      const spec = LOOPS[edge];
      loop = spec && loopFailure(spec, run, options.evidence);
      const stall = spec && loop && stallOf(this.store.listEvents(runId), edge, spec, loop);
      // Listed first: when the cap applies in the same round, the stall is the better reason.
      if (stall) problems.unshift(stall.reason);
      if (problems.length) throw new TransitionError(runId, from, to, problems, stall);
    }

    const patch: StatePatch = {
      ...options.patch,
      ...(to === "needs_human" ? { parked_from: from } : {}),
      ...releaseIfTerminal(to),
      ...loopPatch(run, from, to),
    };
    // The fingerprint goes into the loop's event, so stall detection survives a restarted worker.
    const data = loop ? withLoopData(options.data, loop) : options.data;
    return this.commit(run, to, patch, () => this.store.appendEvent(runId, from, to, options.reason, data));
  }

  /** A human resolves a parked run: approve it onward, send it back, reject or cancel it. */
  resume(runId: string, to: RunState, options: ResumeOptions): Run {
    const run = this.load(runId);
    const from = run.state;
    this.checkLease(run, to, options.owner);

    if (from !== "needs_human") throw new TransitionError(runId, from, to, ["run is not waiting for a human"]);
    if (!options.comment.trim()) throw new TransitionError(runId, from, to, ["a comment explaining the decision is required"]);
    if (!resumeTargets(run).includes(to)) {
      throw new TransitionError(runId, from, to, [
        `run was parked in ${run.parked_from ?? "an unknown stage"}; it can go back, or one step onward from there`,
      ]);
    }

    const patch: StatePatch = {
      waiting_gate: null,
      parked_from: null,
      ...releaseIfTerminal(to),
      ...(options.resetLoops ? { build_iterations: 0, review_rounds: 0, critic_rounds: 0 } : {}),
      // A human sending the run (back) to the gate starts a new round, like the builder handing over.
      ...(to === "gate" ? { round: run.round + 1 } : {}),
    };
    return this.commit(run, to, patch, () => {
      const gate = run.waiting_gate ?? "escalation";
      this.store.recordDecision({
        run_id: runId,
        gate,
        mode: run.waiting_gate ? this.config.gates[run.waiting_gate] : "human",
        outcome: to === "rejected" || to === "cancelled" ? "reject" : "approve",
        actor: "human",
        comment: options.comment,
        commit_sha: options.commitSha ?? null,
      });
      this.store.appendEvent(runId, from, to, `human: ${options.comment}`, {
        gate,
        resetLoops: !!options.resetLoops,
      });
    });
  }

  /**
   * A human stops a run in any active state. Unlike other moves this ignores the lease: the worker
   * holding it may be the very thing being stopped, and its next move will fail on the changed state.
   */
  cancel(runId: string, comment: string): Run {
    const run = this.load(runId);
    if (isTerminal(run.state)) throw new TransitionError(runId, run.state, "cancelled", [`run is already ${run.state}`]);
    if (!comment.trim()) throw new TransitionError(runId, run.state, "cancelled", ["a comment explaining the decision is required"]);
    return this.commit(run, "cancelled", { waiting_gate: null, ...releaseIfTerminal("cancelled") }, () => {
      this.store.recordDecision({
        run_id: runId,
        gate: run.waiting_gate ?? "escalation",
        mode: "human",
        outcome: "reject",
        actor: "human",
        comment,
      });
      this.store.appendEvent(runId, run.state, "cancelled", `human: ${comment}`);
    });
  }

  /**
   * The run's PR was merged or closed on GitHub, by a human or by the merge stage: finish the run.
   * Merged ends in done, closed without merging in cancelled. Allowed from any active or parked
   * state, but only on the run's own PR and only once GitHub says it is no longer open. A run another
   * worker is driving is refused, so this never races that worker's own moves.
   */
  closeByPullRequest(runId: string, pr: Pick<PullRequestState, "number" | "state" | "mergeCommit">, owner?: string): Run {
    const run = this.load(runId);
    const merged = pr.state === "merged";
    const to: RunState = merged ? "done" : "cancelled";
    this.checkLease(run, to, owner);
    const problems: string[] = [];
    if (isTerminal(run.state)) problems.push(`run is already ${run.state}`);
    if (run.pr_number === null) problems.push("run has no pull request");
    else if (pr.number !== run.pr_number) problems.push(`PR #${pr.number} is not the run's PR (#${run.pr_number})`);
    if (pr.state === "open") problems.push(`PR #${pr.number} is still open`);
    if (merged && !pr.mergeCommit) problems.push(`PR #${pr.number} is merged but has no merge commit`);
    if (problems.length) throw new TransitionError(runId, run.state, to, problems);

    const reason = merged ? `merged PR #${pr.number} on GitHub` : `PR #${pr.number} was closed on GitHub without merging`;
    return this.commit(run, to, { waiting_gate: null, parked_from: null, ...releaseIfTerminal(to) }, () => {
      this.store.recordDecision({
        run_id: runId,
        gate: "merge",
        mode: this.config.gates.merge,
        outcome: merged ? "approve" : "reject",
        actor: "human",
        comment: reason,
        commit_sha: merged ? pr.mergeCommit! : null,
      });
      this.store.appendEvent(runId, run.state, to, reason, { pr: pr.number, ...(merged ? { mergeCommit: pr.mergeCommit } : {}) });
    });
  }

  private load(runId: string): Run {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return run;
  }

  private checkLease(run: Run, to: RunState, owner: string | undefined): void {
    const held = run.lease_owner !== null && run.lease_expires_at !== null && run.lease_expires_at > new Date().toISOString();
    if (held && run.lease_owner !== owner) {
      throw new TransitionError(run.id, run.state, to, [`run is leased by ${run.lease_owner}`]);
    }
    if (owner !== undefined && !held) {
      throw new TransitionError(run.id, run.state, to, [`${owner} does not hold a valid lease on this run`]);
    }
  }

  private commit(run: Run, to: RunState, patch: StatePatch, record: () => void): Run {
    return this.store.transaction(() => {
      if (!this.store.writeState(run.id, to, patch, run.state)) {
        const current = this.store.getRun(run.id)?.state ?? "missing";
        throw new TransitionError(run.id, run.state, to, [`run changed concurrently (now ${current})`]);
      }
      record();
      return this.store.getRun(run.id)!;
    });
  }
}

function releaseIfTerminal(to: RunState): StatePatch {
  return isTerminal(to) ? { lease_owner: null, lease_expires_at: null } : {};
}

/** A guard that cannot read its evidence (missing or malformed file) blocks the move rather than crashing. */
function runGuard(guard: Guard, ctx: GuardContext): string[] {
  try {
    return guard(ctx);
  } catch (err) {
    return [`evidence unavailable: ${(err as Error).message}`];
  }
}
