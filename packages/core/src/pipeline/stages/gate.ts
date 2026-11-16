import { rmSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_LENSES } from "@factory/shared";
import { runQualityGate } from "../../gate/gate.js";
import { gitEvidence } from "../../git/worktrees.js";
import type { Run } from "../../store/store.js";
import { gateFingerprint } from "../fingerprint.js";
import { reviewPath, runEvidence } from "../shared.js";
import type { Evidence } from "../transitions.js";
import type { StageContext, StepResult } from "./context.js";

export async function gate(ctx: StageContext, run: Run): Promise<StepResult> {
  const dir = ctx.runDir(run);
  const worktree = ctx.worktreeOf(run);
  const round = run.round;
  // Every entry into the gate starts a new round, so this folder should have no reviews yet. Should
  // one be left over anyway (runs from before the round counter), it is for another commit and must
  // not be reused for whatever this gate passes.
  for (const lens of REVIEW_LENSES) rmSync(reviewPath(join(dir, `round-${round}`), lens), { force: true });
  rmSync(join(dir, `round-${round}`, "verify.md"), { force: true });
  const result = await runQualityGate({
    runId: run.id,
    worktreePath: worktree.path,
    defaultBranch: ctx.defaultBranch,
    checks: ctx.deps.config.checks,
    roundDir: join(dir, `round-${round}`),
    run: ctx.exec,
    events: ctx.deps.events,
    signal: ctx.signal,
  });
  const git = gitEvidence(worktree, ctx.defaultBranch, ctx.exec);
  const fingerprint = gateFingerprint(result, worktree.path);
  const evidence: Evidence = { ...runEvidence(dir, round, git), gateFingerprint: () => fingerprint };

  if (result.passed) {
    // The same facts the gate->review guard needs: the pass is for HEAD, nothing changed since,
    // and it is pushed. Checks that leave the tree dirty or a commit made meanwhile show up here.
    const problems: string[] = [];
    if (git.head() !== result.head) problems.push("HEAD changed after the gate ran");
    if (!git.isClean()) problems.push("the checks left uncommitted changes in the worktree");
    if (!git.isPushed()) problems.push("the checked commit is not pushed");
    if (problems.length) return ctx.escalate(run, `quality gate passed but ${problems.join("; ")}`);
    ctx.move(run, "review", `quality gate passed (round ${round})`, { round, commit: result.head }, evidence);
    return undefined;
  }
  return ctx.loopBack(run, `quality gate failed (round ${round})`, { round }, evidence, "quality gate", `quality gate still failing after round ${round}`, (reason, data) =>
    ctx.escalate(run, reason, data),
  );
}
