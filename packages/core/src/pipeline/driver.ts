import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  isTerminal,
  isTrustedAuthor,
  parseVerdict,
  type AgentRole,
  type FactoryConfig,
  type ParsedVerdict,
  type RunState,
  type VerdictKind,
} from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles, type IssueText, type PromptRole } from "../agents/prompts.js";
import type { AgentRunner } from "../agents/runner.js";
import { runTurn, type TurnResult } from "../agents/turn.js";
import type { TrustedReader } from "../config/trusted.js";
import type { FactoryEvents } from "../events.js";
import { runQualityGate } from "../gate/gate.js";
import { branchName, createWorktree, gitEvidence, type GitEvidence, type Worktree } from "../git/worktrees.js";
import { factoryComment, type GithubPort } from "../github/port.js";
import type { Issue, Project, Run, RunPatch, Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { resolveGate } from "./gates.js";
import { RunMachine, TransitionError, type Evidence } from "./transitions.js";

export const RUNS_DIR = join(".factory", "runs");
export const DEFAULT_PORT_BASE = 4700;
const LEASE_TTL_MS = 15 * 60_000;
const LEASE_RENEW_MS = 60_000;

export function runDirOf(root: string, runId: string): string {
  return join(root, RUNS_DIR, runId);
}

export interface DriverDeps {
  store: Store;
  project: Project;
  /** Config read from the default branch (loadTrustedConfig), never from a working copy. */
  config: FactoryConfig;
  /** Reads prompts and lessons from the default branch. */
  read: TrustedReader;
  runAgent: AgentRunner;
  github: GithubPort;
  /** Lease owner name for this process. */
  owner: string;
  events?: FactoryEvents;
  run?: CommandRunner;
  portBase?: number;
  /** Per-role agent timeouts. */
  timeouts?: Partial<Record<PromptRole, number>>;
}

export type DriveOutcome =
  /** Waiting for a human (needs_human) or the issue author (needs_info). */
  | { kind: "parked"; state: RunState; reason: string }
  | { kind: "finished"; state: RunState }
  /** The subscription's usage limit was hit; run again after resetsAt. State is unchanged. */
  | { kind: "rate_limited"; resetsAt?: string }
  /** Nothing this driver can do: another worker holds the run, or the stage is not automated yet. */
  | { kind: "stopped"; state: RunState; reason: string };

type StepResult = DriveOutcome | undefined;

const ACTIVE: RunState[] = ["intake", "triage", "refine", "critic", "build", "gate", "review", "capture", "pr", "merge", "learn"];

/** Output file of each verdict kind, relative to the run folder. Per-round files live in round-N/. */
function verdictPath(runDir: string, kind: VerdictKind, round: number): string {
  switch (kind) {
    case "checks":
    case "verify":
      return join(runDir, `round-${round}`, `${kind}.md`);
    case "approver":
      return join(runDir, "approval.md");
    default:
      return join(runDir, `${kind}.md`);
  }
}

const noGit: GitEvidence = {
  head: () => {
    throw new Error("the run has no worktree yet");
  },
  isClean: () => {
    throw new Error("the run has no worktree yet");
  },
  commitsAhead: () => {
    throw new Error("the run has no worktree yet");
  },
  isPushed: () => {
    throw new Error("the run has no worktree yet");
  },
};

/** Evidence read from the run folder and worktree, for the state machine's guards. */
export function runEvidence(runDir: string, round: number, git: GitEvidence = noGit): Evidence {
  return {
    verdict: <K extends VerdictKind>(kind: K): ParsedVerdict<K> => {
      const path = verdictPath(runDir, kind, round);
      if (!existsSync(path)) throw new Error(`${relative(runDir, path)} does not exist`);
      return parseVerdict(kind, readFileSync(path, "utf8"));
    },
    reviews: () => [],
    git,
  };
}

/** The text under a "## <name>" heading of an agent's output, if present. */
function section(body: string, name: string): string | undefined {
  const match = new RegExp(`^#{2,3}\\s*${name}\\s*:?\\s*$([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, "im").exec(body);
  return match?.[1]?.trim() || undefined;
}

/**
 * Moves runs through triage -> build -> quality gate, one stage at a time, until a run is parked,
 * finished, rate limited, or reaches a stage that is not automated yet. Every state change goes
 * through RunMachine; the driver only gathers evidence and decides which edge to try.
 */
export class PipelineDriver {
  private readonly machine: RunMachine;
  private readonly run: CommandRunner;

  constructor(private readonly deps: DriverDeps) {
    this.machine = new RunMachine(deps.store, deps.config);
    this.run = deps.run ?? runCommand;
  }

  /** Start a run for a queued issue, or return the run already working on it. */
  startRun(issueNumber: number, options: { unsafe?: boolean } = {}): Run {
    const { store, project } = this.deps;
    const issue = store.getIssue(project.id, issueNumber);
    if (!issue) throw new Error(`issue #${issueNumber} is not synced`);
    if (!issue.queued_at) throw new Error(`issue #${issueNumber} is not queued`);
    const active = store
      .listRuns({ project_id: project.id, states: [...ACTIVE, "needs_info", "needs_human"] })
      .find((r) => r.issue_number === issueNumber);
    if (active) return active;
    return store.createRun({ project_id: project.id, title: issue.title, issue_number: issueNumber, unsafe: options.unsafe });
  }

  async drive(runId: string): Promise<DriveOutcome> {
    const { store, owner } = this.deps;
    if (!store.acquireLease(runId, owner, LEASE_TTL_MS)) {
      const run = store.getRun(runId);
      return { kind: "stopped", state: run?.state ?? "failed", reason: `run is being worked on by ${run?.lease_owner}` };
    }
    const renew = setInterval(() => store.acquireLease(runId, owner, LEASE_TTL_MS), LEASE_RENEW_MS);
    renew.unref();
    try {
      for (;;) {
        const run = this.load(runId);
        if (isTerminal(run.state)) return { kind: "finished", state: run.state };
        if (run.state === "needs_human" || run.state === "needs_info") {
          return { kind: "parked", state: run.state, reason: this.lastReason(run.id) };
        }
        let outcome: StepResult;
        try {
          outcome = await this.step(run);
        } catch (err) {
          outcome = this.onError(runId, run.state, err);
        }
        if (outcome) return outcome;
      }
    } finally {
      clearInterval(renew);
      store.releaseLease(runId, owner);
    }
  }

  private async step(run: Run): Promise<StepResult> {
    switch (run.state) {
      case "intake":
        return this.intake(run);
      case "triage":
        return this.triage(run);
      case "build":
        return this.build(run);
      case "gate":
        return this.gate(run);
      default:
        return { kind: "stopped", state: run.state, reason: `the ${run.state} stage is not automated yet` };
    }
  }

  // ---- stages ---------------------------------------------------------------

  private intake(run: Run): StepResult {
    const issue = this.issueOf(run);
    const dir = this.runDir(run);
    mkdirSync(dir, { recursive: true });
    const trusted = isTrustedAuthor(this.deps.config, issue.author);
    writeFileSync(
      join(dir, "issue.md"),
      [`# #${issue.number}: ${issue.title}`, "", `Author: @${issue.author} (${trusted ? "trusted" : "NOT trusted"})`, `URL: ${issue.url}`, "", issue.body, ""].join("\n"),
    );
    this.move(run, "triage", "issue loaded", { trusted });
    return undefined;
  }

  private async triage(run: Run): Promise<StepResult> {
    const issue = this.issueOf(run);
    const dir = this.runDir(run);
    const root = this.deps.project.repo_path;
    const trusted = isTrustedAuthor(this.deps.config, issue.author);
    const outputFile = join(dir, "triage.md");
    const files = writeRoleFiles(dir, "triage", rolePrompt("triage", this.deps.read), permissionProfile("triage", { runDirFromCwd: relative(root, dir) }));

    const turn = await runTurn({
      run: this.deps.runAgent,
      kind: "triage",
      outputFile,
      agent: {
        ...this.agentBase(run, "triage", root),
        ...files,
        prompt: renderTask({
          role: "triage",
          runId: run.id,
          runDir: dir,
          workDir: root,
          outputFile,
          issue: this.issueText(issue),
          trusted,
          lessons: this.lessons(),
          instructions: "Triage this issue against the repository and write the output file.",
        }),
      },
    });
    if (turn.status !== "ok") return this.agentTrouble(run, "triage", turn);
    const { header, body } = turn.verdict;

    if (!trusted) {
      // Untrusted text may be steering the agent, so a human confirms every outcome, even --unsafe.
      return this.waitForHuman(run, "triage", [`@${issue.author} is not a trusted author`, `triage said ${header.DECISION}`]);
    }
    if (header.DECISION === "REJECT") {
      this.comment(run, "triage-reject", `The factory will not work on this issue.\n\n${section(body, "reasons") ?? section(body, "summary") ?? ""}`);
      this.move(run, "rejected", "triage rejected the issue");
      return undefined;
    }
    if (header.DECISION === "NEEDS_INFO") {
      this.comment(run, "triage-questions", `Before the factory can work on this, please answer:\n\n${section(body, "questions") ?? section(body, "summary") ?? ""}`);
      this.move(run, "needs_info", "triage needs more information");
      return undefined;
    }

    const mode = this.deps.config.gates.triage;
    const concerns = [
      ...(header.READINESS !== "READY" ? ["triage rated the issue INCOMPLETE"] : []),
      ...(header.RISK === "HIGH" ? ["triage rated the risk HIGH"] : []),
    ];
    const gate = resolveGate({
      mode,
      agentDecision: concerns.length ? { decision: "ESCALATE", reasons: concerns } : { decision: "PROCEED" },
      hardRuleHits: [],
      unsafe: run.unsafe,
    });
    if (gate.outcome === "wait_human") return this.waitForHuman(run, "triage", gate.reasons);

    this.deps.store.recordDecision({
      run_id: run.id,
      gate: "triage",
      mode,
      outcome: "proceed",
      actor: mode === "auto" ? "agent" : "system",
      comment: mode === "auto" ? "triage approved: ready, risk not high" : "gate is set to always",
    });
    this.move(run, "build", "triage approved", undefined, runEvidence(dir, 1));
    return undefined;
  }

  private async build(run: Run): Promise<StepResult> {
    const dir = this.runDir(run);
    const issue = this.issueOf(run);
    const worktree = this.ensureWorktree(run);
    run = this.load(run.id);
    const git = gitEvidence(worktree, this.defaultBranch, this.run);
    const outputFile = join(dir, "build.md");
    const files = writeRoleFiles(dir, "builder", rolePrompt("builder", this.deps.read), permissionProfile("builder", { runDirFromCwd: relative(worktree.path, dir) }));
    const session = this.deps.store.latestSession(run.id, "builder");

    const prompt = session
      ? this.builderFollowUp(run, outputFile)
      : renderTask({
          role: "builder",
          runId: run.id,
          runDir: dir,
          workDir: worktree.path,
          outputFile,
          issue: this.issueText(issue),
          trusted: isTrustedAuthor(this.deps.config, issue.author),
          lessons: this.lessons(),
          branch: worktree.branch,
          defaultBranch: this.defaultBranch,
          portBase: run.port_base,
          checks: this.deps.config.checks,
          sections: this.triageScope(dir),
          instructions: [
            `Implement issue #${issue.number} in the working directory on branch \`${worktree.branch}\`.`,
            "Add tests, run the checks, commit, push, open the draft pull request, then write the output file.",
          ].join("\n"),
        });

    const turn = await runTurn({
      run: this.deps.runAgent,
      kind: "build",
      outputFile,
      agent: {
        ...this.agentBase(run, "builder", worktree.path),
        ...files,
        addDirs: [dir],
        resumeSessionId: session,
        prompt,
      },
      validate: (verdict) => (verdict.header.STATUS === "READY" ? this.handOverProblems(worktree, git, verdict.header.COMMIT) : []),
    });
    if (turn.status !== "ok") return this.agentTrouble(run, "builder", turn);

    if (turn.verdict.header.STATUS === "BLOCKED") {
      const blocker = section(turn.verdict.body, "blocker") ?? "the builder reported BLOCKED without details";
      return this.escalate(run, `builder is blocked: ${blocker}`);
    }
    const pr = this.deps.github.findPullRequest(worktree.branch);
    this.move(run, "gate", "builder handed over", { commit: turn.verdict.header.COMMIT }, runEvidence(dir, run.build_iterations + 1, git), {
      pr_number: pr,
    });
    return undefined;
  }

  private async gate(run: Run): Promise<StepResult> {
    const dir = this.runDir(run);
    const worktree = this.worktreeOf(run);
    const round = run.build_iterations + 1;
    const result = await runQualityGate({
      runId: run.id,
      worktreePath: worktree.path,
      defaultBranch: this.defaultBranch,
      checks: this.deps.config.checks,
      roundDir: join(dir, `round-${round}`),
      run: this.run,
      events: this.deps.events,
    });
    const evidence = runEvidence(dir, round, gitEvidence(worktree, this.defaultBranch, this.run));

    if (result.passed) {
      // Reviews are not automated yet (phase 3): a human looks at the draft PR.
      this.move(run, "needs_human", "quality gate passed; reviews are not automated yet", { round }, undefined, { waiting_gate: "review" });
      return undefined;
    }
    try {
      this.move(run, "build", `quality gate failed (round ${round})`, { round }, evidence);
    } catch (err) {
      if (!(err instanceof TransitionError) || this.load(run.id).state !== "gate") throw err;
      return this.escalate(run, `quality gate still failing after round ${round}: ${err.problems.join("; ")}`);
    }
    return undefined;
  }

  // ---- helpers --------------------------------------------------------------

  private get defaultBranch(): string {
    return this.deps.config.project.default_branch;
  }

  private load(runId: string): Run {
    const run = this.deps.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return run;
  }

  private runDir(run: Run): string {
    return runDirOf(this.deps.project.repo_path, run.id);
  }

  private issueOf(run: Run): Issue {
    if (run.issue_number === null) throw new Error(`run ${run.id} has no issue`);
    const issue = this.deps.store.getIssue(this.deps.project.id, run.issue_number);
    if (!issue) throw new Error(`issue #${run.issue_number} is not synced`);
    return issue;
  }

  private issueText(issue: Issue): IssueText {
    return { number: issue.number, title: issue.title, body: issue.body, author: issue.author, url: issue.url };
  }

  private lessons(): string | undefined {
    return this.deps.read(".factory/lessons.md");
  }

  private triageScope(dir: string): { title: string; body: string }[] {
    const path = join(dir, "triage.md");
    if (!existsSync(path)) return [];
    const body = parseVerdict("triage", readFileSync(path, "utf8")).body;
    return [{ title: "Triage result", body }];
  }

  private agentBase(run: Run, role: PromptRole & AgentRole, cwd: string) {
    const { config, timeouts } = this.deps;
    return {
      runId: run.id,
      role,
      model: config.models.roles[role] ?? config.models.default,
      cwd,
      logDir: join(this.runDir(run), "logs"),
      timeoutMs: timeouts?.[role] ?? (role === "builder" ? 90 * 60_000 : 20 * 60_000),
    };
  }

  /** What the builder's resumed session is told: the failed gate report and/or the human's instruction. */
  private builderFollowUp(run: Run, outputFile: string): string {
    const parts: string[] = [];
    const checks = join(this.runDir(run), `round-${run.build_iterations}`, "checks.md");
    if (run.build_iterations > 0 && existsSync(checks)) {
      parts.push(`The quality gate failed in round ${run.build_iterations}. Its report:`, "", readFileSync(checks, "utf8").trim(), "");
      parts.push("Fix the cause, run the checks yourself, commit and push, then write the output file again.");
    }
    const human = this.deps.store.listDecisions(run.id).at(-1);
    if (human?.actor === "human") parts.push("", `A human sent this back to you with this comment: ${human.comment}`);
    if (parts.length === 0) parts.push("Continue where you stopped and finish the hand-over.");
    parts.push("", `Output file: \`${outputFile}\``);
    return parts.join("\n").trim() + "\n";
  }

  /** The hand-over must be the commit that is checked out, committed, pushed, with a PR. */
  private handOverProblems(worktree: Worktree, git: GitEvidence, commit: string): string[] {
    const problems: string[] = [];
    const head = git.head();
    if (commit !== head) problems.push(`COMMIT ${commit.slice(0, 7)} is not HEAD (${head.slice(0, 7)})`);
    if (!git.isClean()) problems.push("the worktree has uncommitted changes");
    if (git.commitsAhead() < 1) problems.push(`the branch has no commits ahead of origin/${this.defaultBranch}`);
    if (!git.isPushed()) problems.push(`the branch is not pushed: run git push -u origin ${worktree.branch}`);
    else if (this.deps.github.findPullRequest(worktree.branch) === undefined) {
      problems.push(`no open pull request for ${worktree.branch}: open a draft PR`);
    }
    return problems;
  }

  private ensureWorktree(run: Run): Worktree {
    if (run.worktree_path && run.branch) return this.worktreeOf(run);
    const issue = this.issueOf(run);
    const worktree = createWorktree({
      root: this.deps.project.repo_path,
      runId: run.id,
      branch: branchName(issue.number, issue.title),
      defaultBranch: this.defaultBranch,
      run: this.run,
    });
    this.deps.store.updateRunFields(run.id, { branch: worktree.branch, worktree_path: worktree.path });
    this.deps.store.allocatePorts(run.id, this.deps.portBase ?? DEFAULT_PORT_BASE);
    this.info(run, `worktree ${relative(this.deps.project.repo_path, worktree.path)} on ${worktree.branch}`);
    return worktree;
  }

  private worktreeOf(run: Run): Worktree {
    if (!run.worktree_path || !run.branch) throw new Error(`run ${run.id} has no worktree`);
    if (!existsSync(run.worktree_path)) throw new Error(`worktree ${run.worktree_path} is missing`);
    return { path: run.worktree_path, branch: run.branch };
  }

  private move(run: Run, to: RunState, reason: string, data?: unknown, evidence?: Evidence, patch?: RunPatch): void {
    this.machine.transition(run.id, to, { reason, data, evidence, patch, owner: this.deps.owner });
    this.deps.events?.emit({ type: "run:state", runId: run.id, from: run.state, to, reason });
  }

  private waitForHuman(run: Run, gate: "triage" | "review", reasons: string[]): StepResult {
    this.deps.store.recordDecision({
      run_id: run.id,
      gate,
      mode: this.deps.config.gates[gate],
      outcome: "escalate",
      actor: "system",
      comment: reasons.join("; "),
    });
    this.move(run, "needs_human", `waiting at ${gate} gate: ${reasons.join("; ")}`, { reasons }, undefined, { waiting_gate: gate });
    return undefined;
  }

  private escalate(run: Run, reason: string): StepResult {
    this.move(run, "needs_human", reason);
    return undefined;
  }

  private agentTrouble(run: Run, role: string, turn: Exclude<TurnResult<VerdictKind>, { status: "ok" }>): StepResult {
    const current = this.load(run.id);
    if (current.state !== run.state) return undefined; // cancelled or moved while the agent ran
    const { outcome } = turn.agent;
    if (turn.status === "failed" && outcome.kind === "rate_limited") {
      this.info(run, `usage limit reached${outcome.resetsAt ? `, resets at ${outcome.resetsAt}` : ""}`);
      return { kind: "rate_limited", resetsAt: outcome.resetsAt };
    }
    if (turn.status === "invalid") return this.escalate(run, `${role} output was rejected twice: ${turn.problems.join("; ")}`);
    const detail = outcome.kind === "error" ? `${outcome.subtype}: ${outcome.message}` : outcome.kind;
    return this.escalate(run, `${role} agent failed (${detail.slice(0, 500)})`);
  }

  /** An unexpected error parks the run for a human instead of leaving it half-done. */
  private onError(runId: string, state: RunState, err: unknown): StepResult {
    const current = this.load(runId);
    if (current.state !== state) return undefined; // e.g. cancelled while this step ran
    const message = err instanceof Error ? err.message : String(err);
    this.move(current, "needs_human", `error in ${state}: ${message.slice(0, 1000)}`);
    return undefined;
  }

  private comment(run: Run, kind: string, body: string): void {
    this.deps.github.commentOnIssue(run.issue_number!, factoryComment(run.id, kind, body));
  }

  private info(run: Run, message: string): void {
    this.deps.events?.emit({ type: "info", runId: run.id, message });
  }

  private lastReason(runId: string): string {
    return this.deps.store.listEvents(runId).at(-1)?.reason ?? "";
  }
}
