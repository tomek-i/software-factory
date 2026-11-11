import {
  STAGES,
  isTerminal,
  type FactoryConfig,
  type ParsedVerdict,
  type RunState,
  type VerdictKind,
} from "@factory/shared";
import type { Run, RunPatch, Store } from "../store/store.js";

/**
 * Forward edges of the pipeline. Every non-terminal state may additionally move to
 * needs_human, failed or cancelled; needs_human may resume into any stage.
 */
const FORWARD: Partial<Record<RunState, readonly RunState[]>> = {
  intake: ["triage"],
  triage: ["refine", "critic", "rejected", "needs_info"],
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

export function allowedTargets(from: RunState): RunState[] {
  if (isTerminal(from)) return [];
  if (from === "needs_human") return [...STAGES, "rejected", "failed", "cancelled"];
  return [...(FORWARD[from] ?? []), ...ALWAYS_ALLOWED];
}

/** Facts about the run's worktree and output files, injected so guards stay testable. */
export interface Evidence {
  verdict<K extends VerdictKind>(kind: K): ParsedVerdict<K>;
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

/** Evidence each edge must show before the run may take it. Returns problems; empty means allowed. */
const GUARDS: Partial<Record<`${RunState}->${RunState}`, Guard>> = {
  "build->gate": ({ evidence }) => {
    const problems: string[] = [];
    if (evidence.verdict("build").header.STATUS !== "READY") problems.push("builder did not report STATUS: READY");
    if (!evidence.git.isClean()) problems.push("worktree has uncommitted changes");
    if (evidence.git.commitsAhead() < 1) problems.push("branch has no commits ahead of the base branch");
    if (!evidence.git.isPushed()) problems.push("branch is not pushed to origin");
    return problems;
  },
  "gate->review": ({ evidence }) => gatedHeadProblems(evidence, "PASS"),
  "gate->build": ({ run, config, evidence }) => {
    const problems = evidence.verdict("checks").header.GATE === "FAIL" ? [] : ["quality gate did not fail"];
    if (run.build_iterations >= config.loops.max_build_iterations) {
      problems.push(`build iteration cap reached (${config.loops.max_build_iterations})`);
    }
    return problems;
  },
  "review->build": ({ run, config }) =>
    run.review_rounds >= config.loops.max_review_rounds
      ? [`review round cap reached (${config.loops.max_review_rounds})`]
      : [],
  // Reviews must have looked at exactly the commit that passed the gate.
  "review->capture": ({ evidence }) => gatedHeadProblems(evidence, "PASS"),
  "critic->refine": ({ run, config }) =>
    run.critic_rounds >= config.loops.max_critic_rounds
      ? [`spec critic round cap reached (${config.loops.max_critic_rounds})`]
      : [],
};

function gatedHeadProblems(evidence: Evidence, expected: "PASS" | "FAIL"): string[] {
  const checks = evidence.verdict("checks").header;
  const problems: string[] = [];
  if (checks.GATE !== expected) problems.push(`quality gate result is ${checks.GATE}, expected ${expected}`);
  const head = evidence.git.head();
  if (checks.COMMIT !== head) problems.push(`gate ran on ${checks.COMMIT.slice(0, 7)} but HEAD is ${head.slice(0, 7)}`);
  return problems;
}

/** Counters bumped when a loop goes round again. */
function loopPatch(run: Run, from: RunState, to: RunState): RunPatch {
  if (from === "gate" && to === "build") return { build_iterations: run.build_iterations + 1 };
  if (from === "review" && to === "build") return { review_rounds: run.review_rounds + 1 };
  if (from === "critic" && to === "refine") return { critic_rounds: run.critic_rounds + 1 };
  return {};
}

export class TransitionError extends Error {
  constructor(
    readonly runId: string,
    readonly from: RunState,
    readonly to: RunState,
    readonly problems: string[],
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
}

/**
 * The only code allowed to change a run's state. Validates the edge, checks the
 * evidence guard, applies loop counters and records an event, all in one transaction.
 */
export class RunMachine {
  constructor(
    private readonly store: Store,
    private readonly config: FactoryConfig,
  ) {}

  transition(runId: string, to: RunState, options: TransitionOptions): Run {
    return this.store.transaction(() => {
      const run = this.store.getRun(runId);
      if (!run) throw new Error(`run ${runId} not found`);
      const from = run.state;

      if (!allowedTargets(from).includes(to)) {
        throw new TransitionError(runId, from, to, [`no edge from ${from} to ${to}`]);
      }

      // A human resuming a parked run is the authority; evidence guards apply to automatic moves.
      const guard = from === "needs_human" ? undefined : GUARDS[`${from}->${to}`];
      if (guard) {
        if (!options.evidence) throw new TransitionError(runId, from, to, ["evidence is required for this move"]);
        const problems = runGuard(guard, { run, config: this.config, evidence: options.evidence });
        if (problems.length) throw new TransitionError(runId, from, to, problems);
      }

      const patch: RunPatch = {
        ...loopPatch(run, from, to),
        ...(from === "needs_human" ? { waiting_gate: null } : {}),
        ...options.patch,
      };
      this.store.writeState(runId, to, patch);
      this.store.appendEvent(runId, from, to, options.reason, options.data);
      return this.store.getRun(runId)!;
    });
  }
}

/** A guard that cannot read its evidence (missing or malformed file) blocks the move rather than crashing. */
function runGuard(guard: Guard, ctx: GuardContext): string[] {
  try {
    return guard(ctx);
  } catch (err) {
    return [`evidence unavailable: ${(err as Error).message}`];
  }
}
