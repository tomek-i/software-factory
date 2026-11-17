import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTrustedIssue, pullRequestTitleProblem } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn } from "../../agents/turn.js";
import { scanSecrets } from "../../gate/gate.js";
import { branchName, createWorktree, gitEvidence, type GitEvidence, type Worktree } from "../../git/worktrees.js";
import type { Issue, Run } from "../../store/store.js";
import { feedbackFile } from "../feedback.js";
import { DEFAULT_PORT_BASE, LONG_SUMMARY_BULLET, longSummaryBullets, prBody, readValid, runEvidence, section } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

export async function build(ctx: StageContext, run: Run): Promise<StepResult> {
  const dir = ctx.runDir(run);
  const issue = ctx.issueOf(run);
  const worktree = ensureWorktree(ctx, run);
  run = ctx.load(run.id);
  const git = gitEvidence(worktree, ctx.defaultBranch, ctx.exec);
  const outputFile = join(dir, "build.md");
  const files = writeRoleFiles(dir, "builder", rolePrompt("builder", ctx.deps.read), permissionProfile("builder", { runDirFromCwd: relative(worktree.path, dir) }));
  const session = ctx.deps.store.latestSession(run.id, "builder");

  const prompt = session
    ? builderFollowUp(ctx, run, outputFile)
    : renderTask({
        role: "builder",
        runId: run.id,
        runDir: dir,
        workDir: worktree.path,
        outputFile,
        issue: ctx.issueText(issue),
        trusted: isTrustedIssue(ctx.deps.config, issue),
        lessons: ctx.lessons(),
        branch: worktree.branch,
        defaultBranch: ctx.defaultBranch,
        portBase: run.port_base,
        checks: ctx.deps.config.checks,
        sections: [...ctx.triageScope(dir), ...ctx.acceptedSpec(run)],
        instructions: [
          `Implement issue #${issue.number} in the working directory on branch \`${worktree.branch}\`.`,
          "Add tests, run the quick checks and the tests that cover your change, commit (do not push), then write the output file.",
        ].join("\n"),
      });

  const turn = await runTurn({
    run: ctx.deps.runAgent,
    kind: "build",
    outputFile,
    agent: {
      ...ctx.agentBase(run, "builder", worktree.path),
      ...files,
      addDirs: [dir],
      resumeSessionId: session,
      prompt,
    },
    validate: (verdict) =>
      verdict.header.STATUS === "READY"
        ? [
            // Only the hand-over that opens the PR names it; later rounds keep its title.
            ...(run.pr_number == null ? [pullRequestTitleProblem(verdict.header.TITLE)].filter((p) => p !== undefined) : []),
            ...handOverProblems(ctx, worktree, git, verdict.header.COMMIT, join(dir, `round-${run.round + 1}`)),
          ]
        : [],
  });
  if (turn.status !== "ok") return ctx.agentTrouble(run, "builder", turn);

  if (turn.verdict.header.STATUS === "BLOCKED") {
    const blocker = section(turn.verdict.body, "blocker") ?? "the builder reported BLOCKED without details";
    return ctx.escalate(run, `builder is blocked: ${blocker}`);
  }
  const long = longSummaryBullets(turn.verdict.body);
  if (long > 0) ctx.info(run, `note: ${long} Summary bullet(s) longer than ${LONG_SUMMARY_BULLET} characters; the PR's What section may be hard to scan`);
  const pr = publish(ctx, worktree, turn.verdict.header.TITLE ?? issue.title, issue, turn.verdict.body, run.unsafe);
  ctx.move(run, "gate", "builder handed over", { commit: turn.verdict.header.COMMIT }, runEvidence(dir, run.round + 1, git), {
    pr_number: pr,
  });
  return undefined;
}

/**
 * Push the branch (never forced) and make sure a draft PR exists. Done by the engine, after the
 * secret scan, so nothing the builder committed reaches GitHub unchecked. The PR keeps the title
 * of the hand-over that opened it.
 */
function publish(ctx: StageContext, worktree: Worktree, title: string, issue: Issue, buildBody: string, unsafe: boolean): number {
  ctx.push(worktree);
  const existing = ctx.deps.github.findPullRequest(worktree.branch);
  if (existing !== undefined) return existing;
  return ctx.deps.github.createDraftPullRequest({
    head: worktree.branch,
    base: ctx.defaultBranch,
    title,
    body: prBody(buildBody, issue.number, unsafe),
  });
}

/**
 * What the builder's resumed session is told: why the run came back (the failed gate's report or
 * the findings the verifier confirmed) and/or the human's instruction.
 */
function builderFollowUp(ctx: StageContext, run: Run, outputFile: string): string {
  const parts: string[] = [];
  const roundDir = join(ctx.runDir(run), `round-${run.round}`);
  const events = ctx.deps.store.listEvents(run.id);
  const last = events.findLastIndex((e) => e.to_state === "build");
  let back = events[last]?.from_state;
  // Sent back by a human: what failed is whatever made the run stop where it was parked.
  if (back === "needs_human") back = events.slice(0, last).findLast((e) => e.to_state === "needs_human")?.from_state;
  const checks = back === "gate" ? readValid("checks", join(roundDir, "checks.md"), (v) => (v.header.GATE === "FAIL" ? [] : ["passed"])) : undefined;
  const verify = back === "review" ? readValid("verify", join(roundDir, "verify.md"), (v) => (v.header.VERDICT === "CONFIRMED" ? [] : ["none confirmed"])) : undefined;
  // The merge stage clears conflicts.md before each re-sync, so one that exists is from the attempt that sent the run back.
  const conflicts = back === "merge" && existsSync(join(roundDir, "resync", "conflicts.md"));
  const resynced = back === "merge" && !conflicts ? readValid("checks", join(roundDir, "resync", "checks.md"), (v) => (v.header.GATE === "FAIL" ? [] : ["passed"])) : undefined;
  // Likewise the open feedback on the PR: cleared at the start of every merge attempt, written only when there is some.
  const feedbackPath = join(ctx.runDir(run), feedbackFile(run.round));
  const feedback = back === "merge" && !conflicts && !resynced && existsSync(feedbackPath);
  if (checks) {
    parts.push(`The quality gate failed in round ${run.round}. Its report:`, "", readFileSync(join(roundDir, "checks.md"), "utf8").trim(), "");
    // The engine pushes after checking the commits; the builder cannot (see permissionProfile).
    parts.push("Fix the cause, rerun what failed, commit (do not push), then write the output file again.");
  } else if (verify) {
    const { findings } = verify;
    parts.push(
      `The reviewers of round ${run.round} found problems, and a verifier confirmed these against the code:`,
      "",
      "```json",
      JSON.stringify(findings, null, 2),
      "```",
      "",
      "Fix each one (with a test where it fits), run the quick checks and the tests that cover your fixes, commit (do not push), then write the output file again.",
    );
  } else if (conflicts) {
    parts.push(
      readFileSync(join(roundDir, "resync", "conflicts.md"), "utf8").trim(),
      "",
      `Merge origin/${ctx.defaultBranch} into your branch with git merge, resolve the conflicts so both sides keep working, run the quick checks and the tests that cover the conflicting files, commit, then write the output file again.`,
    );
  } else if (resynced) {
    parts.push(
      `After origin/${ctx.defaultBranch} was merged into your branch, the quality gate failed in round ${run.round}. Its report:`,
      "",
      readFileSync(join(roundDir, "resync", "checks.md"), "utf8").trim(),
      "",
      "The merge commit is on your branch. Fix the cause, rerun what failed, commit, then write the output file again.",
    );
  } else if (feedback) {
    parts.push(
      readFileSync(feedbackPath, "utf8").trim(),
      "",
      "Fix what is real (with a test where it fits), run the quick checks and the tests that cover your fixes, commit (do not push), then write the output file again. In its summary, say for each point what you changed, or why it needs no change.",
    );
  }
  // Only decisions made since the builder last ran were meant for it (not, say, the triage approval).
  const lastBuild = ctx.deps.store.listAgentRuns(run.id).filter((a) => a.role === "builder").at(-1)?.started_at ?? "";
  const human = ctx.deps.store
    .listDecisions(run.id)
    .filter((d) => d.actor === "human" && d.created_at >= lastBuild)
    .at(-1);
  if (human) parts.push("", `A human sent this back to you with this comment: ${human.comment}`);
  if (parts.length === 0) parts.push("Continue where you stopped and finish the hand-over.");
  parts.push("", `Output file: \`${outputFile}\``);
  return parts.join("\n").trim() + "\n";
}

/** The hand-over must be the checked-out commit, fully committed, with no secrets in any new commit. */
function handOverProblems(ctx: StageContext, worktree: Worktree, git: GitEvidence, commit: string, reportDir: string): string[] {
  const problems: string[] = [];
  const head = git.head();
  if (commit !== head) problems.push(`COMMIT ${commit.slice(0, 7)} is not HEAD (${head.slice(0, 7)})`);
  if (!git.isClean()) problems.push("the worktree has uncommitted changes");
  if (git.commitsAhead() < 1) problems.push(`the branch has no commits ahead of origin/${ctx.defaultBranch}`);
  const secrets = scanSecrets({ worktreePath: worktree.path, defaultBranch: ctx.defaultBranch, reportDir }, ctx.exec);
  for (const hit of secrets.hits) {
    problems.push(`possible secret in ${hit.file}:${hit.line} (${hit.rule}): remove it from the unpushed commits`);
  }
  return problems;
}

function ensureWorktree(ctx: StageContext, run: Run): Worktree {
  if (run.worktree_path && run.branch) return ctx.worktreeOf(run);
  const issue = ctx.issueOf(run);
  const worktree = createWorktree({
    root: ctx.deps.project.repo_path,
    runId: run.id,
    branch: branchName(issue.number, issue.title),
    defaultBranch: ctx.defaultBranch,
    run: ctx.exec,
  });
  ctx.deps.store.updateRunFields(run.id, { branch: worktree.branch, worktree_path: worktree.path });
  ctx.deps.store.allocatePorts(run.id, ctx.deps.portBase ?? DEFAULT_PORT_BASE);
  ctx.info(run, `worktree ${relative(ctx.deps.project.repo_path, worktree.path)} on ${worktree.branch}`);
  return worktree;
}
