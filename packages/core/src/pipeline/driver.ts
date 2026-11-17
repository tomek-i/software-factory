import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTerminal, type RunState } from "@factory/shared";
import type { TurnResult } from "../agents/turn.js";
import type { Run } from "../store/store.js";
import { CLEANUP_MARKER, cleanupFinishedRun, describeCleanup } from "./cleanup.js";
import { build } from "./stages/build.js";
import { capture } from "./stages/capture.js";
import { StageContext, type DriveOutcome, type DriverDeps, type StepResult } from "./stages/context.js";
import { critic } from "./stages/critic.js";
import { gate } from "./stages/gate.js";
import { learn, learnerTurn, skipLessons } from "./stages/learn.js";
import { merge } from "./stages/merge.js";
import { pr } from "./stages/pr.js";
import { refine } from "./stages/refine.js";
import { review } from "./stages/review.js";
import { intake, triage } from "./stages/triage.js";

export {
  approveTarget,
  DEFAULT_PORT_BASE,
  latestSpecRound,
  nextAfterTriage,
  prBody,
  quietMentions,
  REFINE_MARKER,
  runDirOf,
  runEvidence,
  RUNS_DIR,
  waitingCommit,
} from "./shared.js";
export type { DriveOutcome, DriverDeps } from "./stages/context.js";
export { blockingFindings, diffLines, refutedFindings, reviewNotes, verifyProblems, type BlockingFinding, type DiffLines, type LensReview, type ReviewNotes } from "./reviews.js";

const LEASE_TTL_MS = 15 * 60_000;
const LEASE_RENEW_MS = 60_000;

const ACTIVE: RunState[] = ["intake", "triage", "refine", "critic", "build", "gate", "review", "capture", "pr", "merge", "learn"];

/**
 * Moves runs through triage -> build -> quality gate, one stage at a time, until a run is parked,
 * finished, rate limited, or reaches a stage that is not automated yet. Every state change goes
 * through RunMachine; the driver only gathers evidence and decides which edge to try. Each stage
 * lives in its own module under `pipeline/stages/`; `step` dispatches to it.
 */
export class PipelineDriver {
  /** What the stages work with: this driver's ports, its run machine and the helpers they share. */
  private readonly ctx: StageContext;
  /** Aborted when the run being driven is cancelled or this worker loses its lease. */
  private signal?: AbortSignal;

  constructor(private readonly deps: DriverDeps) {
    // The signal is read when a stage uses it: it is set for each drive() and cleared after.
    this.ctx = new StageContext(deps, () => this.signal);
  }

  /** Start a run for a queued issue, or return the run already working on it. */
  startRun(issueNumber: number, options: { unsafe?: boolean } = {}): Run {
    const { store, project } = this.deps;
    const issue = store.getIssue(project.id, issueNumber);
    if (!issue) throw new Error(`issue #${issueNumber} is not synced`);
    if (!issue.queued_at) throw new Error(`issue #${issueNumber} is not queued`);
    // One transaction, so two `factory run` calls at once cannot both create a run.
    return store.transaction(() => {
      const active = store
        .listRuns({ project_id: project.id, states: [...ACTIVE, "needs_info", "needs_human"] })
        .find((r) => r.issue_number === issueNumber);
      if (active) return active;
      return store.createRun({ project_id: project.id, title: issue.title, issue_number: issueNumber, unsafe: options.unsafe });
    });
  }

  /** Send a run that was waiting for the author's answers back to triage. */
  retriage(runId: string, reason = "triage again with the current issue text"): Run {
    const run = this.ctx.load(runId);
    if (run.state !== "needs_info") throw new Error(`run ${runId} is ${run.state}, not waiting for information`);
    this.ctx.machine.transition(runId, "triage", { reason });
    this.deps.events?.emit({ type: "run:state", runId, from: run.state, to: "triage", reason });
    return this.ctx.load(runId);
  }

  async drive(runId: string): Promise<DriveOutcome> {
    const { store, owner } = this.deps;
    if (!store.acquireLease(runId, owner, LEASE_TTL_MS)) {
      const run = store.getRun(runId);
      return { kind: "stopped", state: run?.state ?? "failed", reason: `run is being worked on by ${run?.lease_owner}` };
    }
    this.closeOrphanedAgents(runId);

    // Watch the run while a stage works on it: a human may cancel it from another process, or
    // this worker may lose its lease. Either way the running agent or check must stop now, not
    // when it finishes on its own.
    const controller = new AbortController();
    this.signal = controller.signal;
    let renewedAt = Date.now();
    const watch = setInterval(() => {
      const run = store.getRun(runId);
      if (!run || isTerminal(run.state) || run.lease_owner !== owner) return controller.abort();
      if (Date.now() - renewedAt >= LEASE_RENEW_MS) {
        if (!store.acquireLease(runId, owner, LEASE_TTL_MS)) return controller.abort();
        renewedAt = Date.now();
      }
    }, this.deps.watchMs ?? 2000);
    watch.unref();
    try {
      for (;;) {
        const run = this.ctx.load(runId);
        if (isTerminal(run.state)) return { kind: "finished", state: run.state };
        if (run.state === "needs_human" || run.state === "needs_info") {
          return { kind: "parked", state: run.state, reason: this.ctx.lastReason(run.id) };
        }
        let outcome: StepResult;
        try {
          outcome = await this.step(run);
        } catch (err) {
          outcome = this.onError(runId, run.state, err);
        }
        if (outcome) return outcome;
      }
    } finally {
      clearInterval(watch);
      this.signal = undefined;
      // Nothing of this worker runs in the worktree any more, so a finished run can be cleaned up now.
      this.cleanUp(runId);
      store.releaseLease(runId, owner);
    }
  }

  /**
   * Remove a finished run's worktree and branches (see cleanupRun). Never throws: it runs while
   * drive() returns or throws, and must neither hide that error nor keep the lease from being released.
   */
  private cleanUp(runId: string): void {
    try {
      const run = this.deps.store.getRun(runId);
      if (!run || !isTerminal(run.state)) return;
      const runDir = this.ctx.runDir(run);
      if (existsSync(join(runDir, CLEANUP_MARKER))) return;
      const result = cleanupFinishedRun(this.deps.store, run, { root: this.deps.project.repo_path, runDir, defaultBranch: this.ctx.defaultBranch, run: this.ctx.exec });
      for (const line of describeCleanup(run.id, result)) this.deps.events?.emit({ type: "info", runId, message: `cleanup: ${line}` });
    } catch (err) {
      this.deps.events?.emit({ type: "info", runId, message: `cleanup: could not clean up ${runId}: ${(err as Error).message.split("\n")[0]}` });
    }
  }

  /**
   * Agent rows still marked running when a worker takes the lease belong to a worker that died
   * (crash, Ctrl+C). Close them so nothing treats their stale pid as a live agent.
   */
  private closeOrphanedAgents(runId: string): void {
    for (const agent of this.deps.store.listAgentRuns(runId)) {
      if (agent.status === "running") {
        this.deps.store.finishAgentRun(agent.id, { status: "error", excerpt: `${agent.excerpt ?? ""}\nagent was orphaned: the factory process stopped`.trim() });
      }
    }
  }

  private async step(run: Run): Promise<StepResult> {
    const { ctx } = this;
    ctx.startStep();
    switch (run.state) {
      case "intake":
        return intake(ctx, run);
      case "triage":
        return triage(ctx, run);
      case "refine":
        return refine(ctx, run);
      case "critic":
        return critic(ctx, run);
      case "build":
        return build(ctx, run);
      case "gate":
        return gate(ctx, run);
      case "review":
        return review(ctx, run);
      case "capture":
        return capture(ctx, run);
      case "pr":
        return pr(ctx, run);
      case "merge":
        return merge(ctx, run);
      case "learn":
        return this.learn(run);
      default:
        return { kind: "stopped", state: run.state, reason: `the ${run.state} stage is not automated yet` };
    }
  }

  // The learn stage and its agent turn stay reachable on the instance, so a test can replace either.

  private learn(run: Run): Promise<StepResult> {
    return learn(this.ctx, run, (r, worth) => this.learnerTurn(r, worth));
  }

  /** The learner reads the run's reports and history and proposes lessons in `learn.md`. */
  private learnerTurn(run: Run, worth: string[]): Promise<TurnResult<"learn">> {
    return learnerTurn(this.ctx, run, worth);
  }

  /** An unexpected error parks the run for a human instead of leaving it half-done. */
  private onError(runId: string, state: RunState, err: unknown): StepResult {
    const current = this.ctx.load(runId);
    if (current.state !== state) return undefined; // e.g. cancelled while this step ran
    const message = err instanceof Error ? err.message : String(err);
    // The PR is merged by the time a run learns, so whatever went wrong there must not hold it up.
    if (state === "learn") return skipLessons(this.ctx, current, `error: ${message.slice(0, 1000)}`);
    this.ctx.move(current, "needs_human", `error in ${state}: ${message.slice(0, 1000)}`);
    return undefined;
  }
}
