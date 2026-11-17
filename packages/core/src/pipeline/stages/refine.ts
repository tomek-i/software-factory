import { mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { isTrustedIssue } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn } from "../../agents/turn.js";
import type { Run } from "../../store/store.js";
import { latestRoundWith, latestSpecRound, quietMentions, readValid, REFINE_END_MARKER, REFINE_MARKER, refined, section, specFile, withoutMarkers, withSpecSection } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

/**
 * Triage rated the issue INCOMPLETE, or the spec critic asked for a revision: the refine agent writes
 * what the issue leaves open (acceptance criteria, scope, out of scope, open questions) as a new
 * spec round, and the engine puts it on the issue (see postSpec).
 */
export async function refine(ctx: StageContext, run: Run): Promise<StepResult> {
  const issue = ctx.issueOf(run);
  const dir = ctx.runDir(run);
  const root = ctx.deps.project.repo_path;
  const round = latestSpecRound(dir) + 1;
  const outputFile = specFile(dir, round, "refine.md");
  mkdirSync(dirname(outputFile), { recursive: true });
  const files = writeRoleFiles(dir, "refine", rolePrompt("refine", ctx.deps.read), permissionProfile("refine", { runDirFromCwd: relative(root, dir), outputFile }));

  const sections = ctx.triageScope(dir);
  // The latest usable spec and verdict, skipping rounds where refine was blocked or wrote nothing valid.
  const previous = latestRoundWith(round, (r) => readValid("refine", specFile(dir, r, "refine.md"), refined));
  if (previous) sections.push({ title: `Your spec from round ${previous.round}`, body: previous.value.body });
  const critique = latestRoundWith(round, (r) => readValid("critic", specFile(dir, r, "critic.md"), () => []));
  if (critique) sections.push({ title: `The spec critic's verdict on round ${critique.round}: ${critique.value.header.VERDICT}`, body: critique.value.body });
  // Only a human's call since refine last ran is meant for it (not, say, the triage approval): one
  // at the critic gate, or an escalation such as a blocked refine sent back here.
  const lastRefine = ctx.deps.store.listAgentRuns(run.id).filter((a) => a.role === "refine").at(-1)?.started_at ?? "";
  const human = ctx.deps.store
    .listDecisions(run.id)
    .filter((d) => d.actor === "human" && (d.gate === "critic" || d.gate === "escalation") && d.created_at >= lastRefine)
    .at(-1);
  if (human) sections.push({ title: "A human sent the spec back with this comment", body: human.comment });

  const turn = await runTurn({
    run: ctx.deps.runAgent,
    kind: "refine",
    outputFile,
    agent: {
      ...ctx.agentBase(run, "refine", root),
      ...files,
      prompt: renderTask({
        role: "refine",
        runId: run.id,
        runDir: dir,
        workDir: root,
        outputFile,
        issue: ctx.issueText(issue),
        trusted: isTrustedIssue(ctx.deps.config, issue),
        lessons: ctx.lessons(),
        sections,
        instructions: critique
          ? `Revise the spec of issue #${issue.number}: fix each problem the spec critic listed, then write the output file.`
          : `Write what issue #${issue.number} leaves open, based on the issue and the code, then write the output file.`,
      }),
    },
  });
  if (turn.status !== "ok") return ctx.agentTrouble(run, "refine", turn);
  const { header, body } = turn.verdict;
  if (header.STATUS === "BLOCKED") {
    return ctx.escalate(run, `refine is blocked: ${section(body, "blocker") ?? "refine reported BLOCKED without details"}`);
  }
  postSpec(ctx, run, round, body);
  ctx.move(run, "critic", `refined the issue (spec round ${round})`, { specRound: round });
  return undefined;
}

/**
 * The refined spec on the issue, in one marked place that a later round edits in place, so the issue
 * shows the current spec and does not fill up with old versions. On an issue the factory's account
 * wrote, that is a section at the end of the issue body, so the issue reads as one spec and edits to
 * it reach triage. Anyone else's issue is left as they wrote it and gets a comment.
 */
function postSpec(ctx: StageContext, run: Run, round: number, body: string): void {
  const { github } = ctx.deps;
  const headings: [string, string][] = [
    ["acceptance criteria", "Acceptance criteria"],
    ["scope", "Scope"],
    ["out of scope", "Out of scope"],
    ["open questions", "Open questions"],
  ];
  const parts = headings.flatMap(([name, title]) => {
    const text = section(body, name);
    return text ? [`### ${title}\n${quietMentions(withoutMarkers(text))}`] : [];
  });
  const issue = run.issue_number!;
  const own = github.ownIssueBody(issue);
  if (own !== undefined) {
    const spec = [
      REFINE_MARKER,
      `## Spec (filled in by the factory, spec round ${round})`,
      "A spec critic checks this against the code before anything is built. If any of it is wrong, edit it here.",
      ...parts,
      REFINE_END_MARKER,
    ].join("\n\n");
    github.editIssueBody(issue, withSpecSection(own, spec));
    return;
  }
  const text = [
    REFINE_MARKER,
    `The factory filled in what this issue leaves open (spec round ${round}). A spec critic checks it against the code before anything is built. If any of it is wrong, edit the issue.`,
    ...parts,
  ].join("\n\n");
  const existing = github.findComment(issue, REFINE_MARKER);
  if (existing === undefined) github.commentOnIssue(issue, `${text}\n`);
  else github.editComment(existing, `${text}\n`);
}
