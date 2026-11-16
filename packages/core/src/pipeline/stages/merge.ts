import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTrustedIssue, REVIEW_LENSES, type ParsedVerdict } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn, type TurnResult } from "../../agents/turn.js";
import { runQualityGate } from "../../gate/gate.js";
import { gitEvidence, type GitEvidence, type Worktree } from "../../git/worktrees.js";
import type { PullRequestState, PullRequestCheck } from "../../github/port.js";
import type { Run } from "../../store/store.js";
import { resolveGate, type GateInput } from "../gates.js";
import { changeReport, freshBase } from "../hard-rules.js";
import { bullets, pause, readValid, reviewPath, runEvidence, section, verdictPath } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

/**
 * Merge the run's PR: bring the branch up to date with the default branch, run the quality gate
 * again if that changed it, decide the merge gate, then merge exactly the commit that passed. A
 * conflict or a failing gate goes back to the builder, which costs a review round.
 */
export async function merge(ctx: StageContext, run: Run): Promise<StepResult> {
  const { github, config } = ctx.deps;
  const number = run.pr_number;
  if (number === null) return ctx.escalate(run, "the run has no pull request to merge");
  const pr = github.pullRequestState(number);
  // Merged or closed by a human meanwhile: that settles the run.
  if (pr.state !== "open") return closedOnGithub(ctx, run, pr);
  // Ready before anyone is asked to approve the merge (approving the PR gate comes straight here).
  if (pr.draft) github.markReady(number);

  const dir = ctx.runDir(run);
  const worktree = ctx.worktreeOf(run);
  const round = run.round;
  const resyncDir = join(dir, `round-${round}`, "resync");
  const git = gitEvidence(worktree, ctx.defaultBranch, ctx.exec);
  const evidence = runEvidence(dir, round, git);
  const backToBuild = (reason: string, data: Record<string, unknown>) =>
    ctx.loopBack(run, reason, { round, ...data }, evidence, "merge", `still cannot merge after round ${round}`, (why) => ctx.escalate(run, why));

  const conflicts = resync(ctx, worktree, resyncDir);
  if (conflicts) return backToBuild(`merging ${ctx.defaultBranch} into the branch conflicts in ${conflicts.join(", ")}`, { conflicts });
  let head = git.head();
  if (!passedOn(ctx, dir, round, head)) {
    const result = await runQualityGate({
      runId: run.id,
      worktreePath: worktree.path,
      defaultBranch: ctx.defaultBranch,
      checks: config.checks,
      roundDir: resyncDir,
      run: ctx.exec,
      events: ctx.deps.events,
      signal: ctx.signal,
    });
    if (!result.passed) return backToBuild(`quality gate failed after merging ${ctx.defaultBranch} (round ${round})`, { resync: true });
    head = git.head();
    if (head !== result.head || !git.isClean()) return ctx.escalate(run, "the worktree changed while the quality gate ran after merging the default branch");
  }
  // Whatever a human approves, or GitHub merges, must be what the PR shows; this also catches up
  // on a push that failed in an earlier attempt.
  const justPushed = !git.isPushed();
  if (justPushed) ctx.push(worktree);

  if (!approvalCovers(ctx, run, worktree, head)) {
    let hits: string[];
    try {
      hits = ctx.hardRuleHits(run, worktree, head);
    } catch (err) {
      return ctx.escalate(run, `the hard-rule check failed: ${(err as Error).message}`);
    }
    const mode = config.gates.merge;
    const lifted = run.unsafe && hits.length ? [`hard rules lifted by --unsafe: ${hits.join("; ")}`] : [];
    let agentDecision: GateInput["agentDecision"];
    // Hard rules need a human whatever the approver says, so it is only asked when it can decide.
    if (mode === "auto" && (run.unsafe || hits.length === 0)) {
      const turn = await approverTurn(ctx, run, worktree, head);
      if (turn.status !== "ok") return ctx.agentTrouble(run, "approver", turn);
      agentDecision = { decision: turn.verdict.header.DECISION, reasons: bullets(section(turn.verdict.body, "reasons")) };
    }
    const gate = resolveGate({ mode, agentDecision, hardRuleHits: hits, unsafe: run.unsafe });
    if (gate.outcome === "wait_human") return ctx.waitForHuman(run, "merge", [...gate.reasons, ...lifted], { commit: head });
    ctx.recordProceed(run, "merge", mode, [mode === "auto" ? "the approver said PROCEED" : "gate is set to always", ...lifted].join("; "), head);
  }
  return await mergePullRequest(ctx, run, number, head, git, justPushed);
}

/** Merge exactly `head`, which passed the quality gate and is what GitHub has, then move on to learn. */
async function mergePullRequest(ctx: StageContext, run: Run, number: number, head: string, git: GitEvidence, justPushed: boolean): Promise<StepResult> {
  const { github, config } = ctx.deps;
  const problems: string[] = [];
  if (!passedOn(ctx, ctx.runDir(run), run.round, head)) problems.push(`no passing quality gate on ${head.slice(0, 7)}`);
  if (!git.isClean()) problems.push("the worktree has uncommitted changes");
  if (!git.isPushed()) problems.push(`${head.slice(0, 7)} is not pushed`);
  if (problems.length) return ctx.escalate(run, `will not merge PR #${number}: ${problems.join("; ")}`);
  try {
    if (github.pullRequestState(number).draft) github.markReady(number);
    const waited = await awaitPullRequestChecks(ctx, run, number, head, justPushed);
    if (waited) return waited.result;
    // The last moment to notice a cancel (or a lost lease) before something that cannot be undone.
    if (ctx.load(run.id).state !== run.state) return undefined;
    if (ctx.signal?.aborted) return { kind: "stopped", state: run.state, reason: "this worker lost the run before merging" };
    // --match-head-commit: GitHub refuses if the PR's head is anything but the commit that passed,
    // so a commit pushed while the checks ran is never merged.
    github.mergePullRequest(number, head, config.merge.method);
  } catch (err) {
    return ctx.escalate(run, `could not merge PR #${number}: ${(err as Error).message}`);
  }
  const merged = github.pullRequestState(number);
  ctx.move(run, "learn", `merged PR #${number}`, { pr: number, commit: head, mergeCommit: merged.mergeCommit }, {
    ...runEvidence(ctx.runDir(run), run.round, git),
    pullRequest: () => merged,
  });
  return undefined;
}

/**
 * Wait until the checks that branch protection requires on the PR have passed, so a merge is not
 * refused only because CI is still running. Undefined means go on and merge. A failed check, or
 * one still running after `merge.checks_timeout_min`, needs a human; a cancel stops the wait.
 * Throws when gh cannot read the checks.
 */
async function awaitPullRequestChecks(ctx: StageContext, run: Run, number: number, head: string, justPushed: boolean): Promise<{ result: StepResult } | undefined> {
  const { github, config } = ctx.deps;
  const minutes = config.merge.checks_timeout_min;
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  // Right after a push, GitHub has not created the new commit's checks yet, so "none required"
  // may only mean "none yet". A repo without required checks just waits this long once.
  const graceUntil = justPushed ? started + (ctx.deps.checksGraceMs ?? 60_000) : started;
  const describe = (c: PullRequestCheck) => (c.link ? `${c.name} (${c.link})` : c.name);
  let told = false;
  for (;;) {
    const checks = github.requiredChecks(number);
    if (checks.length === 0 && Date.now() >= graceUntil) return undefined;
    // gh reads the checks of the PR's current head: a commit pushed meanwhile is not ours to judge.
    const prHead = checks.length ? github.pullRequestState(number).head : head;
    if (prHead !== head) {
      return { result: ctx.escalate(run, `PR #${number} moved to ${prHead.slice(0, 7)} while waiting for checks; only ${head.slice(0, 7)} passed the gate`) };
    }
    const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
    if (failed.length) {
      return { result: ctx.escalate(run, `required check${failed.length > 1 ? "s" : ""} failed on PR #${number}: ${failed.map(describe).join("; ")}`) };
    }
    const pending = checks.filter((c) => c.bucket === "pending");
    if (checks.length && pending.length === 0) return undefined;
    const names = pending.length ? pending.map((c) => c.name).join(", ") : "none reported yet";
    if (Date.now() >= deadline) return { result: ctx.escalate(run, `required checks still running on PR #${number} after ${minutes} min: ${names}`) };
    if (!told && pending.length) {
      ctx.info(run, `waiting for required checks on PR #${number}: ${names}`);
      told = true;
    }
    await pause(ctx.deps.checksPollMs ?? 30_000, ctx.signal);
    if (ctx.load(run.id).state !== run.state) return { result: undefined };
    if (ctx.signal?.aborted) return { result: { kind: "stopped", state: run.state, reason: "this worker lost the run while waiting for checks" } };
  }
}

/** The run's PR was merged or closed on GitHub before the factory merged it. */
function closedOnGithub(ctx: StageContext, run: Run, pr: PullRequestState): StepResult {
  const done = ctx.machine.closeByPullRequest(run.id, pr, ctx.deps.owner);
  ctx.deps.events?.emit({ type: "run:state", runId: run.id, from: run.state, to: done.state, reason: ctx.lastReason(run.id) });
  return undefined;
}

/**
 * Merge the latest default branch into the run's branch (not pushed yet). On a conflict the merge
 * is undone and the conflicting files are returned, and listed in `resync/conflicts.md` for the builder.
 */
function resync(ctx: StageContext, worktree: Worktree, resyncDir: string): string[] | undefined {
  const git = (args: string[]) => ctx.exec("git", args, { cwd: worktree.path });
  const conflictsFile = join(resyncDir, "conflicts.md");
  rmSync(conflictsFile, { force: true });
  // A failed re-gate from an earlier attempt would tell the builder about the wrong problem. A pass
  // is kept: it still proves its commit passed.
  const checksFile = join(resyncDir, "checks.md");
  if (readValid("checks", checksFile, (v) => (v.header.GATE === "FAIL" ? [] : ["passed"]))) rmSync(checksFile);
  const fetched = git(["fetch", "--quiet", "--", "origin", ctx.defaultBranch]);
  if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr || fetched.stdout}`);
  const merged = git(["merge", "--no-edit", `origin/${ctx.defaultBranch}`]);
  if (merged.code === 0) return undefined;
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).stdout.split(/\r?\n/).filter(Boolean);
  // Without conflicts the merge never started (dirty worktree, no committer identity, ...): its own error says why.
  if (conflicts.length === 0) throw new Error(`git merge origin/${ctx.defaultBranch} failed: ${merged.stderr || merged.stdout}`);
  const aborted = git(["merge", "--abort"]);
  if (aborted.code !== 0) throw new Error(`git merge --abort failed: ${aborted.stderr || aborted.stdout}`);
  mkdirSync(resyncDir, { recursive: true });
  writeFileSync(conflictsFile, `Merging origin/${ctx.defaultBranch} conflicts in:\n\n${conflicts.map((f) => `- ${f}`).join("\n")}\n`);
  return conflicts;
}

/** Whether this round's quality gate, or its re-run after the re-sync, passed on `head`. */
function passedOn(ctx: StageContext, dir: string, round: number, head: string): boolean {
  const passed = (v: ParsedVerdict<"checks">) => (v.header.GATE === "PASS" && v.header.COMMIT === head ? [] : ["not a pass on HEAD"]);
  const roundDir = join(dir, `round-${round}`);
  return [join(roundDir, "checks.md"), join(roundDir, "resync", "checks.md")].some((path) => readValid("checks", path, passed));
}

/**
 * Whether a human's approval of the merge gate still covers `head`: nothing went back to the
 * builder since, and `head` is the approved commit or adds only merge commits (the engine's
 * re-syncs) on top of it. Any other change needs a fresh approval.
 */
function approvalCovers(ctx: StageContext, run: Run, worktree: Worktree, head: string): boolean {
  const events = ctx.deps.store.listEvents(run.id);
  let approved: string | undefined;
  for (let i = events.length - 1; i >= 0 && approved === undefined; i--) {
    const event = events[i]!;
    if (event.to_state === "build") return false;
    const data = event.data as { gate?: unknown; commit?: unknown } | null;
    if (event.from_state !== "needs_human" || event.to_state !== "merge" || data?.gate !== "merge") continue;
    // `factory resume --to merge` names no commit, so it approves nothing.
    if (typeof data.commit !== "string") return false;
    approved = data.commit;
  }
  if (approved === undefined) return false;
  if (approved === head) return true;
  const cwd = worktree.path;
  if (ctx.exec("git", ["merge-base", "--is-ancestor", approved, head], { cwd }).code !== 0) return false;
  // Along the branch's own line only: the commits a re-sync brings in from the default branch are not the branch's.
  const added = ctx.exec("git", ["rev-list", "--first-parent", "--no-merges", `${approved}..${head}`], { cwd });
  return added.code === 0 && added.stdout.trim() === "";
}

/** The approver weighs the run's reports and the final diff, and says PROCEED or ESCALATE. */
async function approverTurn(ctx: StageContext, run: Run, worktree: Worktree, head: string): Promise<TurnResult<"approver">> {
  const dir = ctx.runDir(run);
  const issue = ctx.issueOf(run);
  const outputFile = verdictPath(dir, "approver", run.round);
  rmSync(outputFile, { force: true });
  const base = freshBase(worktree.path, ctx.defaultBranch, head, ctx.exec);
  const changeFile = join(dir, "approval.diff");
  writeFileSync(changeFile, changeReport(worktree.path, base, head, ctx.exec));
  const roundDir = join(dir, `round-${run.round}`);
  const reports = [
    join(dir, "build.md"),
    join(roundDir, "checks.md"),
    join(roundDir, "resync", "checks.md"),
    ...REVIEW_LENSES.map((lens) => reviewPath(roundDir, lens)),
    join(roundDir, "verify.md"),
  ].filter((path) => existsSync(path));
  const files = writeRoleFiles(dir, "approver", rolePrompt("approver", ctx.deps.read), permissionProfile("approver", { runDirFromCwd: relative(worktree.path, dir), outputFile }));
  return runTurn({
    run: ctx.deps.runAgent,
    kind: "approver",
    outputFile,
    agent: {
      ...ctx.agentBase(run, "approver", worktree.path),
      ...files,
      addDirs: [dir],
      prompt: renderTask({
        role: "approver",
        runId: run.id,
        runDir: dir,
        workDir: worktree.path,
        outputFile,
        issue: ctx.issueText(issue),
        trusted: isTrustedIssue(ctx.deps.config, issue),
        lessons: ctx.lessons(),
        branch: worktree.branch,
        defaultBranch: ctx.defaultBranch,
        sections: [...ctx.triageScope(dir), ...ctx.acceptedSpec(run), { title: "Run files", body: reports.map((path) => `- \`${path}\``).join("\n") }],
        instructions: [
          `Decide whether PR #${run.pr_number} for issue #${issue.number} may be merged.`,
          `Base: \`${base}\` (where the branch left ${ctx.defaultBranch}). Final commit: \`${head}\`.`,
          `The commits and the full diff are in \`${changeFile}\`. Read the run files and the diff, then write the output file.`,
        ].join("\n"),
      }),
    },
  });
}
