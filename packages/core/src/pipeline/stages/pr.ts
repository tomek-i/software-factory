import { gitEvidence, snapshot } from "../../git/worktrees.js";
import type { Run } from "../../store/store.js";
import { resolveGate } from "../gates.js";
import { runEvidence } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

/** The PR gate, then take the draft PR out of draft so it reads as ready for a human's review. */
export function pr(ctx: StageContext, run: Run): StepResult {
  if (run.pr_number === null) return ctx.escalate(run, "the run has no pull request");
  const mode = ctx.deps.config.gates.pr;
  const gate = resolveGate({ mode, agentDecision: { decision: "PROCEED" }, hardRuleHits: [], unsafe: run.unsafe });
  if (gate.outcome === "wait_human") return ctx.waitForHuman(run, "pr", gate.reasons);
  const { github } = ctx.deps;
  if (github.pullRequestState(run.pr_number).draft) github.markReady(run.pr_number);
  const git = snapshot(gitEvidence(ctx.worktreeOf(run), ctx.defaultBranch, ctx.exec));
  ctx.recordProceed(run, "pr", mode, `PR #${run.pr_number} marked ready`, git.head());
  ctx.move(run, "merge", `PR #${run.pr_number} is ready`, undefined, runEvidence(ctx.runDir(run), run.round, git));
  return undefined;
}
