import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTrustedIssue, parseCapturePlan, parseVerdict, type CapturePlan } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn } from "../../agents/turn.js";
import { renderCaptureReport, screenshotsSection, type CaptureOutcome } from "../../capture/report.js";
import { gitEvidence, type Worktree } from "../../git/worktrees.js";
import { MEDIA_MARKER, mediaTag } from "../../github/media.js";
import { PORT_BLOCK_SIZE, type Run } from "../../store/store.js";
import { changeReport, freshBase } from "../hard-rules.js";
import { verdictPath } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

/**
 * Screenshots (before and after) and a walkthrough video of a UI change, uploaded and shown in the
 * PR description. A capture agent plans what to shoot; the engine starts the app and drives the
 * browser. Nothing here fails the run: whatever goes wrong is reported in round-N/capture-report.md
 * and the PR, and the run goes on to the PR gate. Only a usage limit or a cancel stops it here.
 */
export async function capture(ctx: StageContext, run: Run): Promise<StepResult> {
  const skipped = captureSkipped(ctx, run);
  if (skipped) {
    ctx.info(run, `capture skipped: ${skipped}`);
    ctx.move(run, "pr", `capture skipped: ${skipped}`);
    return undefined;
  }
  const dir = ctx.runDir(run);
  const roundDir = join(dir, `round-${run.round}`);
  const captureDir = join(roundDir, "capture");
  const worktree = ctx.worktreeOf(run);
  // A capture interrupted earlier (usage limit, crash) starts afresh rather than mixing two attempts.
  rmSync(captureDir, { recursive: true, force: true });
  mkdirSync(captureDir, { recursive: true });

  const outcome: CaptureOutcome = {};
  const planned = await capturePlan(ctx, run, worktree, roundDir);
  if ("stop" in planned) return planned.stop;
  // Undoing what the app writes is only safe on a tree that was clean: a run resumed into capture
  // may hold a human's uncommitted edits, which must never be wiped.
  const dirty = planned.plan ? uncommitted(ctx, worktree) : [];
  if (planned.problem) outcome.problem = planned.problem;
  else if (!planned.plan) outcome.skipped = planned.skip;
  else if (dirty.length) outcome.skipped = `the worktree has uncommitted changes (${dirty.slice(0, 5).join(", ")}), so the app was not started`;
  else {
    const ports = run.port_base === null ? [] : Array.from({ length: PORT_BLOCK_SIZE }, (_, i) => run.port_base! + i);
    try {
      outcome.result = await ctx.capturer.capture({
        runId: run.id,
        root: ctx.deps.project.repo_path,
        worktreePath: worktree.path,
        defaultBranch: ctx.defaultBranch,
        app: { ...ctx.deps.config.app, start: ctx.deps.config.app.start! },
        plan: planned.plan,
        outDir: captureDir,
        ports,
        signal: ctx.signal,
      });
    } catch (err) {
      outcome.problem = `capture failed: ${(err as Error).message.split("\n")[0]}`;
    }
    if (ctx.load(run.id).state !== run.state) return undefined; // cancelled while the app ran
    outcome.restored = restoreWorktree(ctx, worktree);
    await uploadMedia(ctx, run, outcome);
    if (ctx.load(run.id).state !== run.state) return undefined; // cancelled while the media uploaded
  }

  writeFileSync(join(roundDir, "capture-report.md"), renderCaptureReport(outcome));
  // The PR's copy: local paths shortened. The report above keeps the full text.
  const roots = [ctx.deps.project.repo_path, worktree.path];
  writeFileSync(join(captureDir, "screenshots.md"), `${screenshotsSection(outcome, run.id, { roots })}\n`);
  ctx.updatePrDescription(run);
  const summary = outcome.skipped
    ? `no screenshots: ${outcome.skipped}`
    : outcome.problem || outcome.result?.status !== "captured"
      ? `screenshots could not be taken: ${(outcome.problem ?? outcome.result?.problem ?? "").split("\n")[0]}`
      : `captured ${outcome.result.pages.length} page(s)${outcome.uploadProblem ? "; the upload failed" : ""}`;
  ctx.info(run, `capture: ${summary} (round-${run.round}/capture-report.md)`);
  ctx.move(run, "pr", `capture: ${summary}`.slice(0, 500));
  return undefined;
}

/** Why the capture stage has nothing to do: the change is not user-visible, or there is no app to start. */
function captureSkipped(ctx: StageContext, run: Run): string | undefined {
  const path = join(ctx.runDir(run), "triage.md");
  const surfaces = existsSync(path) ? parseVerdict("triage", readFileSync(path, "utf8")).header.SURFACES : [];
  if (!surfaces.includes("ui")) return "triage did not list ui in SURFACES";
  if (!ctx.deps.config.app.start) return "app.start is not configured";
  return undefined;
}

/**
 * The capture agent's plan, or why there is none. `stop` ends the stage for now (a usage limit, or
 * the run was cancelled while the agent ran).
 */
async function capturePlan(ctx: StageContext, run: Run, worktree: Worktree, roundDir: string): Promise<{ plan?: CapturePlan; skip?: string; problem?: string } | { stop: StepResult }> {
  const dir = ctx.runDir(run);
  const issue = ctx.issueOf(run);
  const outputFile = verdictPath(dir, "capture", run.round);
  const changeFile = join(roundDir, "change.diff");
  let base: string;
  let head: string;
  try {
    head = gitEvidence(worktree, ctx.defaultBranch, ctx.exec).head();
    base = freshBase(worktree.path, ctx.defaultBranch, head, ctx.exec);
    // The reviewers' copy, unless the run got here some other way (e.g. a human's resume).
    if (!existsSync(changeFile)) writeFileSync(changeFile, changeReport(worktree.path, base, head, ctx.exec));
  } catch (err) {
    return { problem: `could not prepare the change for the capture agent: ${(err as Error).message}` };
  }
  const files = writeRoleFiles(dir, "capture", rolePrompt("capture", ctx.deps.read), permissionProfile("capture", { runDirFromCwd: relative(worktree.path, dir), outputFile }));
  const turn = await runTurn({
    run: ctx.deps.runAgent,
    kind: "capture",
    outputFile,
    validate: (verdict) => (verdict.header.CAPTURE === "PLAN" ? parseCapturePlan(verdict.body).problems : []),
    agent: {
      ...ctx.agentBase(run, "capture", worktree.path),
      ...files,
      addDirs: [dir],
      prompt: renderTask({
        role: "capture",
        runId: run.id,
        runDir: dir,
        workDir: worktree.path,
        outputFile,
        issue: ctx.issueText(issue),
        trusted: isTrustedIssue(ctx.deps.config, issue),
        lessons: ctx.lessons(),
        branch: worktree.branch,
        defaultBranch: ctx.defaultBranch,
        sections: [...ctx.triageScope(dir), ...ctx.acceptedSpec(run)],
        instructions: [
          `Plan the screenshots and the walkthrough of the change on branch \`${worktree.branch}\`.`,
          `Base: \`${base}\` (where the branch left ${ctx.defaultBranch}). Commit: \`${head}\`.`,
          `The commits and the full diff are in \`${changeFile}\`. Read it and the code you need, then write the output file.`,
        ].join("\n"),
      }),
    },
  });
  if (turn.status === "ok") {
    if (turn.verdict.header.CAPTURE === "SKIP") return { skip: `the capture agent found nothing to show${turn.verdict.summary[0] ? ` (${turn.verdict.summary[0]})` : ""}` };
    return { plan: parseCapturePlan(turn.verdict.body).plan! };
  }
  if (turn.status === "failed" && turn.agent.outcome.kind === "rate_limited") return { stop: ctx.agentTrouble(run, "capture", turn) };
  if (ctx.load(run.id).state !== run.state) return { stop: undefined };
  return { problem: ctx.troubleReason("capture agent", turn) };
}

/**
 * Undo what the app wrote into the worktree (build output that is not ignored, a generated
 * file): the tree was clean when capture began, and the PR and merge stages need it clean.
 * Ignored files (node_modules, caches) stay. Returns the paths that were undone.
 */
function restoreWorktree(ctx: StageContext, worktree: Worktree): string[] {
  const changed = uncommitted(ctx, worktree);
  if (changed.length === 0) return [];
  const git = (args: string[]) => ctx.exec("git", args, { cwd: worktree.path });
  git(["checkout", "--", "."]);
  git(["clean", "-fdq"]);
  return changed;
}

/** Paths `git status` reports as changed or untracked (not ignored) in the worktree. */
function uncommitted(ctx: StageContext, worktree: Worktree): string[] {
  const status = ctx.exec("git", ["status", "--porcelain"], { cwd: worktree.path });
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr}`);
  return status.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
}

/** Upload the screenshots and the video. A failure is noted in the outcome; it never stops the run. */
/** Best effort, like `factory cancel` itself: delete the release of a run that ended while it uploaded. */
function dropStoppedRunsRelease(ctx: StageContext, run: Run): void {
  try {
    ctx.capturer.discard(run.id);
    rmSync(join(ctx.runDir(run), MEDIA_MARKER));
  } catch (err) {
    ctx.info(run, `could not delete the screenshots release (${(err as Error).message.split("\n")[0]}); delete it with \`gh release delete ${mediaTag(run.id)} --yes\``);
  }
}

async function uploadMedia(ctx: StageContext, run: Run, outcome: CaptureOutcome): Promise<void> {
  const result = outcome.result;
  if (result?.status !== "captured") return;
  const files = [
    ...result.pages.flatMap((p) => [...p.after, ...(p.before ?? [])].flatMap((s) => (s.file ? [s.file] : []))),
    // The narrated video, when there is one, instead of the silent one: the PR links only one.
    ...(result.walkthrough?.narrated ? [result.walkthrough.narrated] : result.walkthrough?.video ? [result.walkthrough.video] : []),
    ...(result.walkthrough?.screenshots ?? []),
  ];
  if (files.length === 0) return;
  try {
    const published = await ctx.capturer.publish(run.id, run.pr_number, files, ctx.signal);
    outcome.urls = published.urls;
    outcome.mediaFallback = published.fallback;
    outcome.mediaFallbackDetail = published.fallbackDetail;
    // So ending the run without merging can delete the release again (see deleteMedia). PR
    // attachments cannot be deleted, so there is nothing to remember for them.
    if (published.release) {
      writeFileSync(join(ctx.runDir(run), MEDIA_MARKER), `${published.release}\n`);
      // Cancelled while it uploaded: the cancel looked for the marker before it was written.
      if (ctx.load(run.id).state !== run.state) dropStoppedRunsRelease(ctx, run);
    }
  } catch (err) {
    outcome.uploadProblem = (err as Error).message.split("\n")[0];
  }
}
