import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTrustedIssue, REVIEW_LENSES, type ParsedVerdict } from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles } from "../../agents/prompts.js";
import { runTurn, type TurnResult } from "../../agents/turn.js";
import { runQualityGate } from "../../gate/gate.js";
import { gitEvidence, type GitEvidence, type Worktree } from "../../git/worktrees.js";
import type { PullRequestState, RequiredCheck } from "../../github/port.js";
import type { Run } from "../../store/store.js";
import { acceptanceReasons, latestAcceptanceRecord, tickMetCriteria } from "../acceptance.js";
import {
  acknowledgedBy,
  feedbackData,
  feedbackFile,
  feedbackKeys,
  feedbackReasons,
  feedbackReport,
  hasFeedback,
  readOpenFeedback,
  untrustedReason,
  type Acknowledged,
  type OpenFeedback,
} from "../feedback.js";
import { gateFingerprint, resyncFingerprint } from "../fingerprint.js";
import { resolveGate, type GateInput } from "../gates.js";
import { changeReport } from "../hard-rules.js";
import { bullets, pause, readValid, reviewPath, runEvidence, section, verdictPath } from "../shared.js";
import type { StageContext, StepResult } from "./context.js";

/**
 * Merge the run's PR: bring the branch up to date with the default branch, run the quality gate
 * again if that changed it, wait for the PR's required checks, look at its open review threads and
 * failed optional checks, decide the merge gate, then read the checks and the open feedback once
 * more and merge exactly the commit that passed. A conflict, a failing gate or open feedback in
 * `merge.open_feedback: fix` goes back to the builder, which costs a re-sync round
 * (loops.max_resyncs), not a review round.
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
  // A failed re-sync counts against loops.max_resyncs, not the review rounds: the change itself may be fine.
  const backToBuild = (reason: string, data: Record<string, unknown>, fingerprint: string) =>
    ctx.loopBack(
      run,
      reason,
      { round, ...data },
      { ...runEvidence(dir, round, git), resyncFingerprint: () => fingerprint },
      "merge",
      `still cannot merge after round ${round}`,
      (why, stall) => ctx.escalate(run, why, stall),
    );

  const feedbackPath = join(dir, feedbackFile(round));
  // Open feedback from an earlier attempt would tell the builder about the wrong problems.
  rmSync(feedbackPath, { force: true });
  /**
   * The PR's open review threads and failed optional checks, per `merge.open_feedback`: a round for
   * the builder (`result`), or the reasons a human has to decide on (none when nothing is open). What
   * the human approval covering `head` saw no longer counts: that human chose to merge anyway.
   */
  const lookAtFeedback = (required: string[]): FeedbackOutcome => {
    const mode = config.merge.open_feedback;
    if (mode === "ignore") return { reasons: [] };
    let open: OpenFeedback;
    try {
      open = readOpenFeedback(github, number, required, acknowledgedFeedback(ctx, run, worktree, head));
    } catch (err) {
      return { result: ctx.escalate(run, `could not read the review threads and checks of PR #${number}: ${(err as Error).message}`) };
    }
    if (!hasFeedback(open)) return { reasons: [] };
    // For the builder, whether it gets them now or a human sends the run back with them.
    mkdirSync(resyncDir, { recursive: true });
    writeFileSync(feedbackPath, feedbackReport(config, number, open));
    const data = { openFeedback: feedbackData(open) };
    const untrusted = mode === "fix" ? untrustedReason(config, open) : undefined;
    if (mode === "fix" && !untrusted) {
      const why = `open feedback on PR #${number}: ${feedbackReasons(open).join("; ")}`;
      return { result: backToBuild(why, data, resyncFingerprint({ feedback: feedbackKeys(open) })) };
    }
    return { reasons: [...feedbackReasons(open), ...(untrusted ? [untrusted] : [])], data };
  };

  const conflicts = resync(ctx, worktree, resyncDir);
  if (conflicts) return backToBuild(`merging ${ctx.defaultBranch} into the branch conflicts in ${conflicts.join(", ")}`, { conflicts }, resyncFingerprint({ conflicts }));
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
    if (!result.passed) {
      const fingerprint = resyncFingerprint({ gate: gateFingerprint(result, worktree.path) });
      return backToBuild(`quality gate failed after merging ${ctx.defaultBranch} (round ${round})`, { resync: true }, fingerprint);
    }
    head = git.head();
    if (head !== result.head || !git.isClean()) return ctx.escalate(run, "the worktree changed while the quality gate ran after merging the default branch");
  }
  // Whatever a human approves, or GitHub merges, must be what the PR shows; this also catches up
  // on a push that failed in an earlier attempt.
  const justPushed = !git.isPushed(head);
  if (justPushed) ctx.push(worktree);

  // Read the checks before anyone is asked: an approval given while a required check has failed,
  // or is about to, would only be wasted. A failure goes to a human as it is, never to the gate.
  let checks: ChecksOutcome;
  try {
    checks = await awaitRequiredChecks(ctx, run, number, head, justPushed);
  } catch (err) {
    return ctx.escalate(run, `could not merge PR #${number}: ${(err as Error).message}`);
  }
  if ("result" in checks) return checks.result;
  const checksNote = checks.passed.length ? [`required checks passed on ${head.slice(0, 7)}: ${checks.passed.join(", ")}`] : [];
  const feedback = lookAtFeedback(checks.required);
  if ("result" in feedback) return feedback.result;

  // Open feedback needs a decision even when an earlier approval covers this commit.
  if (feedback.reasons.length || !approvalCovers(ctx, run, worktree, head)) {
    let hits: string[];
    try {
      hits = ctx.hardRuleHits(run, worktree, head);
    } catch (err) {
      return ctx.escalate(run, `the hard-rule check failed: ${(err as Error).message}`);
    }
    const mode = config.gates.merge;
    const lifted = run.unsafe && hits.length ? [`hard rules lifted by --unsafe: ${hits.join("; ")}`] : [];
    let agentDecision: GateInput["agentDecision"];
    // Hard rules and open feedback need a human whatever the approver says, so it is only asked when it can decide.
    if (mode === "auto" && (run.unsafe || hits.length === 0) && feedback.reasons.length === 0) {
      const turn = await approverTurn(ctx, run, worktree, head);
      if (turn.status !== "ok") return ctx.agentTrouble(run, "approver", turn);
      agentDecision = { decision: turn.verdict.header.DECISION, reasons: bullets(section(turn.verdict.body, "reasons")) };
    }
    const gate = resolveGate({ mode, agentDecision, hardRuleHits: hits, unsafe: run.unsafe, forceHumanReasons: feedback.reasons });
    if (gate.outcome === "wait_human") {
      const since = approvalSince(ctx, run);
      // The criteria the acceptance lens could not check are for whoever approves the merge.
      const toCheck = acceptanceReasons(latestAcceptanceRecord(dir)?.record);
      return ctx.waitForHuman(run, "merge", [...gate.reasons, ...lifted, ...(since ? [since] : []), ...checksNote, ...toCheck], { commit: head, ...feedback.data });
    }
    ctx.recordProceed(run, "merge", mode, [mode === "auto" ? "the approver said PROCEED" : "gate is set to always", ...lifted, ...checksNote].join("; "), head);
  }
  // The checks and the open feedback are read again right before the merge (no second grace period):
  // a commit pushed, a check re-run or a comment posted while the gate was decided must still be caught.
  return await mergePullRequest(ctx, run, number, head, git, lookAtFeedback);
}

/** `result`: stop with it. `reasons`: what a human has to decide on, none when nothing is open; `data` for the parked move. */
type FeedbackOutcome = { result: StepResult } | { reasons: string[]; data?: Record<string, unknown> };

/**
 * The open feedback the human approval that still covers `head` was parked with ("merge anyway").
 * A new commit from the builder, or a new thread or failed check, is not covered.
 */
function acknowledgedFeedback(ctx: StageContext, run: Run, worktree: Worktree, head: string): Acknowledged {
  if (!approvalCovers(ctx, run, worktree, head)) return { threads: [], checks: [] };
  const events = ctx.deps.store.listEvents(run.id);
  const approval = events.findLastIndex((e) => e.from_state === "needs_human" && e.to_state === "merge" && (e.data as { gate?: unknown } | null)?.gate === "merge");
  return acknowledgedBy(events, approval);
}

/**
 * What became of the last human approval of the merge gate, when a failed re-sync sent the run back
 * to the builder after it: the builder's commits need a fresh approval, and the human should know why.
 */
function approvalSince(ctx: StageContext, run: Run): string | undefined {
  const events = ctx.deps.store.listEvents(run.id);
  const approval = events.findLastIndex((e) => {
    const data = e.data as { gate?: unknown; commit?: unknown } | null;
    return e.from_state === "needs_human" && e.to_state === "merge" && data?.gate === "merge" && typeof data.commit === "string";
  });
  if (approval < 0) return undefined;
  const commit = (events[approval]!.data as { commit: string }).commit.slice(0, 7);
  const back = events.slice(approval + 1).find((e) => e.from_state === "merge" && e.to_state === "build");
  const data = back?.data as { conflicts?: unknown; resync?: unknown } | null | undefined;
  if (Array.isArray(data?.conflicts)) {
    return `approved at ${commit}, then ${ctx.defaultBranch} conflicted in ${data.conflicts.join(", ")}; the builder resolved it`;
  }
  if (data?.resync === true) return `approved at ${commit}, then the quality gate failed after merging ${ctx.defaultBranch}; the builder fixed it`;
  return undefined;
}

/** Merge exactly `head`, which passed the quality gate and is what GitHub has, then move on to learn. */
async function mergePullRequest(
  ctx: StageContext,
  run: Run,
  number: number,
  head: string,
  git: GitEvidence,
  lookAtFeedback: (required: string[]) => FeedbackOutcome,
): Promise<StepResult> {
  const { github, config } = ctx.deps;
  const problems: string[] = [];
  if (!passedOn(ctx, ctx.runDir(run), run.round, head)) problems.push(`no passing quality gate on ${head.slice(0, 7)}`);
  if (!git.isClean()) problems.push("the worktree has uncommitted changes");
  if (!git.isPushed()) problems.push(`${head.slice(0, 7)} is not pushed`);
  if (problems.length) return ctx.escalate(run, `will not merge PR #${number}: ${problems.join("; ")}`);
  let required: string[];
  try {
    if (github.pullRequestState(number).draft) github.markReady(number);
    const waited = await awaitRequiredChecks(ctx, run, number, head, false);
    if ("result" in waited) return waited.result;
    required = waited.required;
  } catch (err) {
    return ctx.escalate(run, `could not merge PR #${number}: ${(err as Error).message}`);
  }
  // Bots post late and people comment after an approval: what is open now still counts.
  const feedback = lookAtFeedback(required);
  if ("result" in feedback) return feedback.result;
  if (feedback.reasons.length) {
    const gate = resolveGate({ mode: config.gates.merge, hardRuleHits: [], unsafe: run.unsafe, forceHumanReasons: feedback.reasons });
    return ctx.waitForHuman(run, "merge", gate.reasons, { commit: head, ...feedback.data });
  }
  try {
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
  tickAfterMerge(ctx, run);
  return undefined;
}

/** `result`: stop with it. `passed`: every required check is done and none failed; their names. `required`: the names of all of them. */
type ChecksOutcome = { result: StepResult } | { passed: string[]; required: string[] };

/** What one look at the PR's required checks says: go on, stop for a human, or look again later. */
export type ChecksVerdict =
  | { kind: "passed"; passed: string[]; required: string[] }
  | { kind: "escalate"; reason: string; failedChecks?: { name: string; link?: string }[] }
  | { kind: "wait"; pending: string[] };

export interface ChecksMoment {
  number: number;
  /** The commit that passed the gate. */
  head: string;
  /** The PR's head on GitHub; only asked for when there are checks to judge. */
  prHead: () => string;
  now: number;
  deadline: number;
  /** Until then, no required checks may only mean GitHub has not created them yet. */
  graceUntil: number;
  minutes: number;
}

/** Judge the required checks gh reported, at one moment of the wait. No I/O but `prHead`. */
export function judgeChecks(checks: RequiredCheck[], at: ChecksMoment): ChecksVerdict {
  const { number, head } = at;
  if (checks.length === 0 && at.now >= at.graceUntil) return { kind: "passed", passed: [], required: [] };
  // gh reads the checks of the PR's current head: a commit pushed meanwhile is not ours to judge.
  const prHead = checks.length ? at.prHead() : head;
  if (prHead !== head) {
    return { kind: "escalate", reason: `PR #${number} moved to ${prHead.slice(0, 7)} while waiting for checks; only ${head.slice(0, 7)} passed the gate` };
  }
  const describe = (c: RequiredCheck) => (c.link ? `${c.name} (${c.link})` : c.name);
  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  if (failed.length) {
    // A plain escalation for now. This is where a builder "fix" round or recovery actions for a
    // failed check would hook in.
    return {
      kind: "escalate",
      reason: `required check${failed.length > 1 ? "s" : ""} failed on PR #${number}: ${failed.map(describe).join("; ")}`,
      failedChecks: failed.map((c) => ({ name: c.name, ...(c.link ? { link: c.link } : {}) })),
    };
  }
  const pending = checks.filter((c) => c.bucket === "pending").map((c) => c.name);
  if (checks.length && pending.length === 0) {
    return { kind: "passed", passed: checks.map((c) => (c.bucket === "skipping" ? `${c.name} (skipped)` : c.name)), required: checks.map((c) => c.name) };
  }
  if (at.now >= at.deadline) {
    return { kind: "escalate", reason: `required checks still running on PR #${number} after ${at.minutes} min: ${pending.length ? pending.join(", ") : "none reported yet"}` };
  }
  return { kind: "wait", pending };
}

/**
 * Wait until the checks that branch protection requires on the PR have passed, so nobody approves
 * a commit CI is about to fail, and a merge is not refused only because CI is still running. A failed
 * check, or one still running after `merge.checks_timeout_min`, needs a human; a cancel stops the wait.
 * Throws when gh cannot read the checks.
 */
async function awaitRequiredChecks(ctx: StageContext, run: Run, number: number, head: string, justPushed: boolean): Promise<ChecksOutcome> {
  const { github, config } = ctx.deps;
  const minutes = config.merge.checks_timeout_min;
  const started = Date.now();
  const deadline = started + minutes * 60_000;
  // Right after a push, GitHub has not created the new commit's checks yet, so "none required"
  // may only mean "none yet". A repo without required checks just waits this long once.
  const graceUntil = justPushed ? started + (ctx.deps.checksGraceMs ?? 60_000) : started;
  let told = false;
  for (;;) {
    const checks = github.requiredChecks(number);
    const verdict = judgeChecks(checks, { number, head, prHead: () => github.pullRequestState(number).head, now: Date.now(), deadline, graceUntil, minutes });
    if (verdict.kind === "passed") return { passed: verdict.passed, required: verdict.required };
    if (verdict.kind === "escalate") {
      return { result: ctx.escalate(run, verdict.reason, verdict.failedChecks ? { failedChecks: verdict.failedChecks } : undefined) };
    }
    if (!told && verdict.pending.length) {
      ctx.info(run, `waiting for required checks on PR #${number}: ${verdict.pending.join(", ")}`);
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
  if (pr.state === "merged") tickAfterMerge(ctx, run);
  return undefined;
}

/** Only once the PR is merged: tick the criteria the acceptance lens found MET on GitHub. */
function tickAfterMerge(ctx: StageContext, run: Run): void {
  if (run.issue_number === null) return;
  for (const note of tickMetCriteria(ctx.deps.github, ctx.runDir(run), run.issue_number)) ctx.info(run, note);
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
  // A fact about two commits, which never changes; the merge stage asks it up to three times.
  return ctx.once(`covers|${approved}|${head}`, () => {
    if (ctx.exec("git", ["merge-base", "--is-ancestor", approved, head], { cwd }).code !== 0) return false;
    // Along the branch's own line only: the commits a re-sync brings in from the default branch are not the branch's.
    const added = ctx.exec("git", ["rev-list", "--first-parent", "--no-merges", `${approved}..${head}`], { cwd });
    return added.code === 0 && added.stdout.trim() === "";
  });
}

/** The approver weighs the run's reports and the final diff, and says PROCEED or ESCALATE. */
async function approverTurn(ctx: StageContext, run: Run, worktree: Worktree, head: string): Promise<TurnResult<"approver">> {
  const dir = ctx.runDir(run);
  const issue = ctx.issueOf(run);
  const outputFile = verdictPath(dir, "approver", run.round);
  rmSync(outputFile, { force: true });
  const base = ctx.freshBase(worktree, head);
  const changeFile = join(dir, "approval.diff");
  writeFileSync(changeFile, changeReport(worktree.path, base, head, ctx.exec));
  const roundDir = join(dir, `round-${run.round}`);
  const reports = [
    join(dir, "build.md"),
    join(roundDir, "checks.md"),
    join(roundDir, "resync", "checks.md"),
    ...REVIEW_LENSES.map((lens) => reviewPath(roundDir, lens)),
    join(roundDir, "acceptance.json"),
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
