import { rmSync } from "node:fs";
import { join } from "node:path";
import { REVIEW_LENSES } from "@factory/shared";
import { runQualityGate } from "../../gate/gate.js";
import { gitEvidence, snapshot } from "../../git/worktrees.js";
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
  for (const file of ["verify.md", "acceptance.md", "acceptance.json"]) rmSync(join(dir, `round-${round}`, file), { force: true });
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
  // The checks are done: nothing changes the worktree between here and the move, so the stage's
  // own checks and the guard's read each fact once. HEAD is the gate's own last read, which it
  // checked against the HEAD the checks started on.
  const git = snapshot(gitEvidence(worktree, ctx.defaultBranch, ctx.exec), result.head);
  const fingerprint = gateFingerprint(result, worktree.path);
  const evidence: Evidence = { ...runEvidence(dir, round, git), gateFingerprint: () => fingerprint };

  if (result.passed) {
    // The same facts the gate->review guard needs: nothing changed since, and it is pushed. Checks
    // that leave the tree dirty show up here; a commit made while they ran fails the gate itself.
    const problems: string[] = [];
    if (!git.isClean()) problems.push("the checks left uncommitted changes in the worktree");
    if (!git.isPushed()) problems.push("the checked commit is not pushed");
    if (problems.length) return ctx.escalate(run, `quality gate passed but ${problems.join("; ")}`);
    ctx.move(run, "review", `quality gate passed (round ${round})`, { round, commit: result.head }, evidence);
    return undefined;
  }
  // Checks that only ran out of time, on every attempt, point at a slow machine more often than at
  // the code; a builder sent back with no failure to fix would only lose a round or break working code.
  const failed = result.checks.filter((c) => !c.passed);
  if (result.secrets.hits.length === 0 && failed.length > 0 && failed.every((c) => c.timedOut)) {
    const names = failed.map((c) => c.name).join(", ");
    return ctx.escalate(
      run,
      `quality gate timed out (round ${round}): ${names} ran past timeout_sec on every attempt; resume to gate to run it again, or to build if the code hangs`,
      { round, timedOut: failed.map((c) => c.name) },
    );
  }
  return ctx.loopBack(run, `quality gate failed (round ${round})`, { round }, evidence, "quality gate", `quality gate still failing after round ${round}`, (reason, data) =>
    ctx.escalate(run, reason, data),
  );
}
