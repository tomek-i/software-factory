import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTrustedIssue } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn } from "../../agents/turn.js";
import type { Run } from "../../store/store.js";
import { issueFingerprint } from "../fingerprint.js";
import { resolveGate } from "../gates.js";
import { nextAfterTriage, runEvidence, section } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

/** Intake writes the issue into the run folder; triage decides whether and how the factory takes it on. */

export function intake(ctx: StageContext, run: Run): StepResult {
  const issue = ctx.issueOf(run);
  const dir = ctx.runDir(run);
  mkdirSync(dir, { recursive: true });
  const trusted = isTrustedIssue(ctx.deps.config, issue);
  writeFileSync(
    join(dir, "issue.md"),
    [`# #${issue.number}: ${issue.title}`, "", `Author: @${issue.author} (${trusted ? "trusted" : "NOT trusted"})`, `URL: ${issue.url}`, "", issue.body, ""].join("\n"),
  );
  ctx.move(run, "triage", "issue loaded", { trusted });
  return undefined;
}

export async function triage(ctx: StageContext, run: Run): Promise<StepResult> {
  const issue = ctx.issueOf(run);
  const dir = ctx.runDir(run);
  const root = ctx.deps.project.repo_path;
  const trusted = isTrustedIssue(ctx.deps.config, issue);
  const outputFile = join(dir, "triage.md");
  const files = writeRoleFiles(dir, "triage", rolePrompt("triage", ctx.deps.read), permissionProfile("triage", { runDirFromCwd: relative(root, dir) }));

  const turn = await runTurn({
    run: ctx.deps.runAgent,
    kind: "triage",
    outputFile,
    agent: {
      ...ctx.agentBase(run, "triage", root),
      ...files,
      prompt: renderTask({
        role: "triage",
        runId: run.id,
        runDir: dir,
        workDir: root,
        outputFile,
        issue: ctx.issueText(issue),
        trusted,
        lessons: ctx.lessons(),
        instructions: "Triage this issue against the repository and write the output file.",
      }),
    },
  });
  if (turn.status !== "ok") return ctx.agentTrouble(run, "triage", turn);
  const { header, body } = turn.verdict;
  // What a human approves at this gate, so a later triage of the same issue can tell whether that approval still holds.
  const judged: TriageJudgement = { gate: "triage", issue: issueFingerprint(issue), trusted, decision: header.DECISION, risk: header.RISK };

  if (!trusted) {
    // Untrusted text may be steering the agent, so a human confirms every outcome, even --unsafe.
    return ctx.waitForHuman(run, "triage", [`@${issue.author} is not a trusted author`, `triage said ${header.DECISION}`], { ...judged });
  }
  if (header.DECISION === "REJECT") {
    ctx.comment(run, "triage-reject", `The factory will not work on this issue.\n\n${section(body, "reasons") ?? section(body, "summary") ?? ""}`);
    ctx.move(run, "rejected", "triage rejected the issue");
    return undefined;
  }
  if (header.DECISION === "NEEDS_INFO") {
    ctx.comment(run, "triage-questions", `Before the factory can work on this, please answer:\n\n${section(body, "questions") ?? section(body, "summary") ?? ""}`);
    ctx.move(run, "needs_info", "triage needs more information");
    return undefined;
  }

  const mode = ctx.deps.config.gates.triage;
  // An INCOMPLETE issue is no reason to stop: refine fills in what it leaves open.
  const concerns = header.RISK === "HIGH" ? ["triage rated the risk HIGH"] : [];
  const gate = resolveGate({
    mode,
    agentDecision: concerns.length ? { decision: "ESCALATE", reasons: concerns } : { decision: "PROCEED" },
    hardRuleHits: [],
    unsafe: run.unsafe,
  });
  let carried: string | undefined;
  if (gate.outcome === "wait_human") {
    // A restart triages the same issue again: a human who already approved it is not asked twice.
    carried = carriedApproval(ctx, run, judged);
    if (!carried) return ctx.waitForHuman(run, "triage", gate.reasons, { ...judged });
  }

  ctx.deps.store.recordDecision({
    run_id: run.id,
    gate: "triage",
    mode,
    outcome: "proceed",
    actor: carried || mode !== "auto" ? "system" : "agent",
    comment: carried ?? (mode === "auto" ? "triage approved: risk not high" : "gate is set to always"),
  });
  const next = nextAfterTriage(dir, ctx.deps.config);
  const reason = next === "refine" ? "triage approved; the issue is incomplete" : "triage approved";
  ctx.move(run, next, carried ? `${reason} (${carried})` : reason, carried ? { carriedOver: true } : undefined, runEvidence(dir, 1));
  return undefined;
}

/** What triage saw when it parked at its gate; recorded on the parking event. */
interface TriageJudgement {
  gate: "triage";
  /** issueFingerprint of the title and body triage read. */
  issue: string;
  trusted: boolean;
  decision: string;
  risk: string;
}

const RISKS = ["LOW", "MEDIUM", "HIGH"];
/** Where a human's approval of the triage gate sends the run. */
const APPROVED: readonly string[] = ["refine", "critic", "build"];

/**
 * The comment for carrying over a human's earlier approval of this run's triage gate, or undefined
 * when a human must be asked again. It only holds when the human's latest answer at this gate was an
 * approval, for the same issue text from a trusted author, triage said APPROVE then and now, and the
 * risk is no higher than the one approved. Only the run's own events count.
 */
function carriedApproval(ctx: StageContext, run: Run, now: TriageJudgement): string | undefined {
  if (!now.trusted || now.decision !== "APPROVE") return undefined;
  const events = ctx.deps.store.listEvents(run.id);
  for (let i = events.length - 1; i > 0; i--) {
    const answer = events[i]!;
    const parked = events[i - 1]!;
    if (answer.from_state !== "needs_human" || parked.to_state !== "needs_human") continue;
    const then = parked.data as Partial<TriageJudgement> | null;
    if (parked.from_state !== "triage" || then?.gate !== "triage") continue;
    // The latest answer at the triage gate decides: anything but an approval asks again.
    if (!APPROVED.includes(answer.to_state)) return undefined;
    const sameIssue = then.issue === now.issue && then.trusted === true && then.decision === "APPROVE";
    const riskThen = RISKS.indexOf(then.risk ?? "");
    if (!sameIssue || riskThen < 0 || RISKS.indexOf(now.risk) > riskThen) return undefined;
    return `carried over the human approval of ${answer.created_at}: the issue is unchanged and triage says APPROVE at risk ${now.risk} (approved at ${then.risk})`;
  }
  return undefined;
}
