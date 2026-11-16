import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTrustedIssue } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn } from "../../agents/turn.js";
import type { Run } from "../../store/store.js";
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

  if (!trusted) {
    // Untrusted text may be steering the agent, so a human confirms every outcome, even --unsafe.
    return ctx.waitForHuman(run, "triage", [`@${issue.author} is not a trusted author`, `triage said ${header.DECISION}`]);
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
  if (gate.outcome === "wait_human") return ctx.waitForHuman(run, "triage", gate.reasons);

  ctx.deps.store.recordDecision({
    run_id: run.id,
    gate: "triage",
    mode,
    outcome: "proceed",
    actor: mode === "auto" ? "agent" : "system",
    comment: mode === "auto" ? "triage approved: risk not high" : "gate is set to always",
  });
  const next = nextAfterTriage(dir, ctx.deps.config);
  ctx.move(run, next, next === "refine" ? "triage approved; the issue is incomplete" : "triage approved", undefined, runEvidence(dir, 1));
  return undefined;
}
