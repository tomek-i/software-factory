import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { isBlocking, isTrustedIssue, parseLessons, REVIEW_LENSES, type Gate, type ParsedVerdict } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn, type TurnResult } from "../../agents/turn.js";
import type { Run } from "../../store/store.js";
import { afterTriage, approveTarget, clip, readReview, readValid, reviewPath, verdictPath } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

/**
 * After the merge, a learner looks back at a run that did not go smoothly and proposes lessons,
 * stored for a human to approve (`factory lessons`); nothing reaches `.factory/lessons.md` here.
 * The merge has happened, so nothing in this stage may hold the run up: a learner that fails, hits
 * the usage limit or writes something malformed only means no lessons from this run, with a note.
 * `learner` runs the learner turn: learnerTurn, unless the driver hands in its own.
 */
export async function learn(
  ctx: StageContext,
  run: Run,
  learner: (run: Run, worth: string[]) => Promise<TurnResult<"learn">> = (r, w) => learnerTurn(ctx, r, w),
): Promise<StepResult> {
  let worth: string[];
  try {
    worth = learnReasons(ctx, run);
  } catch (err) {
    return skipLessons(ctx, run, `could not read the run's history: ${(err as Error).message}`);
  }
  // Saves usage: a run that went through cleanly has nothing to teach.
  if (worth.length === 0) {
    ctx.move(run, "done", "nothing to learn: one round, no failed checks or blocking findings, no human stepped in");
    return undefined;
  }
  let turn: TurnResult<"learn">;
  try {
    turn = await learner(run, worth);
  } catch (err) {
    return skipLessons(ctx, run, `the learner could not start: ${(err as Error).message}`);
  }
  if (ctx.load(run.id).state !== run.state) return undefined; // cancelled while the learner ran
  if (turn.status !== "ok") {
    const { outcome } = turn.agent;
    // The run is finished, so there is nothing to continue after the reset: this run's lessons are skipped.
    const why =
      turn.status === "failed" && outcome.kind === "rate_limited"
        ? `usage limit reached${outcome.resetsAt ? ` (resets at ${outcome.resetsAt})` : ""}`
        : ctx.troubleReason("learner", turn);
    return skipLessons(ctx, run, why);
  }
  const { store } = ctx.deps;
  try {
    const lessons = parseLessons(turn.verdict.body);
    // One transaction, so a crash in between never stores the same proposals twice.
    store.transaction(() => {
      store.addLessons(run.id, lessons);
      const reason = lessons.length
        ? `${lessons.length} lesson${lessons.length > 1 ? "s" : ""} proposed; see \`factory lessons\``
        : "the learner proposed no lessons";
      ctx.move(run, "done", reason, { lessons: lessons.length });
    });
  } catch (err) {
    if (ctx.load(run.id).state !== run.state) return undefined; // cancelled meanwhile
    return skipLessons(ctx, run, `could not store lessons: ${(err as Error).message}`);
  }
  return undefined;
}

/** Finish a merged run without lessons, saying why. */
export function skipLessons(ctx: StageContext, run: Run, why: string): StepResult {
  ctx.info(run, `warning: no lessons from this run: ${why}`);
  ctx.move(run, "done", `lessons skipped: ${why}`, { warning: why });
  return undefined;
}

/**
 * Why a merged run is worth the learner's time. Empty for a run that went through in one round
 * with no failed check, no blocking finding and no human stepping in other than to approve a gate.
 */
function learnReasons(ctx: StageContext, run: Run): string[] {
  const dir = ctx.runDir(run);
  const reasons: string[] = [];
  if (run.round > 1) reasons.push(`it took ${run.round} rounds`);
  const failed = (v: ParsedVerdict<"checks">) => (v.header.GATE === "FAIL" ? [] : ["passed"]);
  for (let round = 1; round <= run.round; round++) {
    const roundDir = join(dir, `round-${round}`);
    for (const file of ["checks.md", "resync/checks.md"]) {
      if (readValid("checks", join(roundDir, file), failed)) reasons.push(`the quality gate failed (round-${round}/${file})`);
    }
    for (const lens of REVIEW_LENSES) {
      if (readReview(roundDir, lens)?.findings.some(isBlocking)) reasons.push(`the ${lens} review had blocking findings (round-${round}/review-${lens}.md)`);
    }
  }
  const events = ctx.deps.store.listEvents(run.id);
  for (const [i, event] of events.entries()) {
    if (event.to_state === "needs_info") reasons.push(`triage asked the author for more information: ${clip(event.reason)}`);
    if (event.to_state === "needs_human") {
      if (!event.reason.startsWith("waiting at ")) {
        reasons.push(`escalated: ${clip(event.reason)}`);
      } else {
        // Waiting only because the gate is set to human is routine; a hard rule or the approver
        // escalating is not.
        const waited = (event.data as { reasons?: unknown } | null)?.reasons;
        const why = Array.isArray(waited) ? waited.filter((r): r is string => typeof r === "string") : [];
        for (const hit of why.filter((r) => r.startsWith("hard rule: "))) reasons.push(`stopped by a ${clip(hit)}`);
        if (event.from_state === "merge" && ctx.deps.config.gates.merge === "auto") {
          const approver = why.filter((r) => !r.startsWith("hard rule") && r !== "gate is set to human");
          if (approver.length) reasons.push(`the approver escalated: ${clip(approver.join("; "))}`);
        }
      }
    }
    if (event.from_state !== "needs_human") continue;
    const gate = (event.data as { gate?: unknown } | null)?.gate;
    const parkedFrom = events.slice(0, i).findLast((e) => e.to_state === "needs_human")?.from_state ?? null;
    const approval = typeof gate === "string" && gate !== "escalation" && approveTarget({ waiting_gate: gate as Gate, parked_from: parkedFrom }, afterTriage(event.to_state)) === event.to_state;
    if (!approval) reasons.push(`a human sent the run to ${event.to_state}: ${clip(event.reason.replace(/^human: /, ""))}`);
  }
  return reasons;
}

/** The learner reads the run's reports and history and proposes lessons in `learn.md`. */
export async function learnerTurn(ctx: StageContext, run: Run, worth: string[]): Promise<TurnResult<"learn">> {
  const dir = ctx.runDir(run);
  const issue = ctx.issueOf(run);
  const outputFile = verdictPath(dir, "learn", run.round);
  // The merged branch's worktree is kept after the merge; the repo root will do if it was removed.
  const cwd = run.worktree_path && existsSync(run.worktree_path) ? run.worktree_path : ctx.deps.project.repo_path;
  const rounds = Array.from({ length: run.round }, (_, i) => join(dir, `round-${i + 1}`));
  const reports = [
    join(dir, "build.md"),
    ...rounds.flatMap((roundDir) => [
      join(roundDir, "checks.md"),
      ...REVIEW_LENSES.map((lens) => reviewPath(roundDir, lens)),
      join(roundDir, "verify.md"),
      join(roundDir, "resync", "conflicts.md"),
      join(roundDir, "resync", "checks.md"),
    ]),
    join(dir, "approval.md"),
  ].filter((path) => existsSync(path));
  const { store } = ctx.deps;
  const history = store.listEvents(run.id);
  const events = history.map((e) => `- ${e.from_state ?? "-"} -> ${e.to_state}: ${clip(e.reason)}`);
  // Where a human sent the run, and their comment: approving a gate and sending work back read alike in the decisions.
  const human = history
    .filter((e) => e.from_state === "needs_human")
    .map((e) => {
      const gate = (e.data as { gate?: unknown } | null)?.gate;
      const where = typeof gate === "string" && gate !== "escalation" ? `at the ${gate} gate` : "after an escalation";
      return `- ${where}, sent the run to ${e.to_state}: ${clip(e.reason.replace(/^human: /, ""))}`;
    });
  const files = writeRoleFiles(dir, "learner", rolePrompt("learner", ctx.deps.read), permissionProfile("learner", { runDirFromCwd: relative(cwd, dir), outputFile }));
  return runTurn({
    run: ctx.deps.runAgent,
    kind: "learn",
    outputFile,
    agent: {
      ...ctx.agentBase(run, "learner", cwd),
      ...files,
      addDirs: [dir],
      prompt: renderTask({
        role: "learner",
        runId: run.id,
        runDir: dir,
        workDir: cwd,
        outputFile,
        issue: ctx.issueText(issue),
        trusted: isTrustedIssue(ctx.deps.config, issue),
        lessons: ctx.lessons(),
        branch: run.branch ?? undefined,
        defaultBranch: ctx.defaultBranch,
        sections: [
          ...ctx.triageScope(dir),
          { title: "Why this run is worth a look", body: worth.map((w) => `- ${w}`).join("\n") },
          {
            title: "Run history",
            body: ["Events, oldest first (written by the engine; reasons may quote agents):", ...events, "", "Human decisions:", ...(human.length ? human : ["(none)"])].join("\n"),
          },
          { title: "Run files", body: reports.map((path) => `- \`${path}\``).join("\n") },
        ],
        instructions: [
          `PR #${run.pr_number} for issue #${issue.number} has been merged. Look back at how this run got there.`,
          "Read the run files and the history, then write the output file with the lessons you propose (often none).",
        ].join("\n"),
      }),
    },
  });
}
