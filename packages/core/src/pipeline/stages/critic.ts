import { mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { isTrustedIssue, type GateMode } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn, type TurnResult } from "../../agents/turn.js";
import type { Run } from "../../store/store.js";
import { resolveGate } from "../gates.js";
import { bullets, criticRound, quietMentions, readValid, runEvidence, section, specFile } from "../shared.js";
import { TransitionError } from "../transitions.js";
import type { StageContext, StepResult } from "./context.js";

/**
 * The spec critic gate. Like the approver, the critic agent only runs in `auto` mode: `always` passes
 * straight on to build and `human` waits without spending an agent turn. The critic checks the
 * issue's claims and criteria, and the refined spec, against the code. ACCEPT moves on to build,
 * REVISE goes back to refine (up to loops.max_critic_rounds, then a human decides), REJECT ends the
 * run, and questions only the issue's author can answer wait for them in needs_info.
 */
export async function critic(ctx: StageContext, run: Run): Promise<StepResult> {
  const dir = ctx.runDir(run);
  const mode = ctx.deps.config.gates.critic;
  const issue = ctx.issueOf(run);
  // A spec written or judged from untrusted text goes to the builder only after a human read it,
  // whatever the gate mode, even with --unsafe.
  const untrusted = isTrustedIssue(ctx.deps.config, issue) ? [] : [`@${issue.author} is not a trusted author`];
  if (mode !== "auto") {
    const gate = resolveGate({ mode, hardRuleHits: [], unsafe: run.unsafe, forceHumanReasons: untrusted });
    if (gate.outcome === "wait_human") return ctx.waitForHuman(run, "critic", gate.reasons);
    recordSpecProceed(ctx, run, mode, "gate is set to always");
    ctx.move(run, "build", "spec critic gate is set to always", undefined, runEvidence(dir, run.round));
    return undefined;
  }

  const round = criticRound(dir);
  const turn = await criticTurn(ctx, run, round);
  if (turn.status !== "ok") return ctx.agentTrouble(run, "spec critic", turn);
  const { header, body } = turn.verdict;
  const problems = bullets(section(body, "problems"));
  const questions = bullets(section(body, "questions"));

  if (header.VERDICT === "REJECT") {
    ctx.comment(run, "critic-reject", `The factory will not work on this issue as written:\n\n${quietMentions(section(body, "problems") ?? "")}`);
    ctx.move(run, "rejected", "the spec critic rejected the issue", { specRound: round });
    return undefined;
  }
  // Only the author can answer these, so the run waits for them as it does when triage asks. Once
  // they have answered, `factory run` triages the issue again and the spec starts a new round.
  if (questions.length) {
    ctx.comment(run, "critic-questions", `Before the factory can build this, please answer:\n\n${quietMentions(section(body, "questions") ?? "")}`);
    ctx.move(run, "needs_info", `the spec critic has questions only the author can answer: ${questions.join("; ")}`, { specRound: round });
    return undefined;
  }
  if (header.VERDICT === "REVISE") {
    try {
      ctx.move(run, "refine", `the spec critic asked for a revision (spec round ${round})`, { specRound: round }, runEvidence(dir, run.round));
    } catch (err) {
      // Only the round cap is an expected stop here; anything else is reported as the error it is.
      if (!(err instanceof TransitionError) || ctx.load(run.id).state !== run.state || !err.problems.some((p) => p.includes("cap reached"))) throw err;
      const spec = ctx.currentSpec(run)?.verdict;
      const open = [...problems, ...bullets(spec && section(spec.body, "open questions"))];
      return ctx.waitForHuman(run, "critic", [`the spec critic still asks for revisions after spec round ${round}: ${err.problems.join("; ")}`, ...open.map((q) => `open: ${q}`)], {
        specRound: round,
      });
    }
    return undefined;
  }

  const gate = resolveGate({ mode, agentDecision: { decision: "PROCEED" }, hardRuleHits: [], unsafe: run.unsafe, forceHumanReasons: untrusted });
  if (gate.outcome === "wait_human") return ctx.waitForHuman(run, "critic", [...gate.reasons, "the spec critic accepted the spec"], { specRound: round });
  recordSpecProceed(ctx, run, mode, `the spec critic accepted spec round ${round}`);
  ctx.move(run, "build", `the spec critic accepted the spec (round ${round})`, { specRound: round }, runEvidence(dir, run.round));
  return undefined;
}

/** The critic gate let the run through without a human. There is no commit yet to record. */
function recordSpecProceed(ctx: StageContext, run: Run, mode: GateMode, comment: string): void {
  ctx.deps.store.recordDecision({ run_id: run.id, gate: "critic", mode, outcome: "proceed", actor: mode === "auto" ? "agent" : "system", comment });
}

/** The critic checks the issue, and the current refined spec if there is one, against the code. */
function criticTurn(ctx: StageContext, run: Run, round: number): Promise<TurnResult<"critic">> {
  const issue = ctx.issueOf(run);
  const dir = ctx.runDir(run);
  const root = ctx.deps.project.repo_path;
  const outputFile = specFile(dir, round, "critic.md");
  mkdirSync(dirname(outputFile), { recursive: true });
  const files = writeRoleFiles(dir, "critic", rolePrompt("critic", ctx.deps.read), permissionProfile("critic", { runDirFromCwd: relative(root, dir), outputFile }));
  const sections = ctx.triageScope(dir);
  const spec = ctx.currentSpec(run);
  if (spec) sections.push({ title: `Refined spec (round ${spec.round})`, body: spec.verdict.body });
  const earlier = round > 1 ? readValid("critic", specFile(dir, round - 1, "critic.md"), () => []) : undefined;
  if (earlier) sections.push({ title: `Your verdict on round ${round - 1}: ${earlier.header.VERDICT}`, body: earlier.body });
  return runTurn({
    run: ctx.deps.runAgent,
    kind: "critic",
    outputFile,
    validate: (verdict) =>
      verdict.header.VERDICT !== "ACCEPT" && bullets(section(verdict.body, "problems")).length === 0
        ? [`VERDICT: ${verdict.header.VERDICT} needs the problems listed under ## Problems`]
        : [],
    agent: {
      ...ctx.agentBase(run, "critic", root),
      ...files,
      prompt: renderTask({
        role: "critic",
        runId: run.id,
        runDir: dir,
        workDir: root,
        outputFile,
        issue: ctx.issueText(issue),
        trusted: isTrustedIssue(ctx.deps.config, issue),
        lessons: ctx.lessons(),
        sections,
        instructions: `Check the claims and acceptance criteria of issue #${issue.number}${spec ? " and its refined spec" : ""} against the code, then write the output file.`,
      }),
    },
  });
}
