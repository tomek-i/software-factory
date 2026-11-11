import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  isTerminal,
  isTrustedAuthor,
  parseVerdict,
  resolveModel,
  type AgentRole,
  type FactoryConfig,
  type Gate,
  type ParsedVerdict,
  type RunState,
  type VerdictKind,
} from "@factory/shared";
import { permissionProfile, renderTask, rolePrompt, writeRoleFiles, type IssueText, type PromptRole } from "../agents/prompts.js";
import type { AgentRunner } from "../agents/runner.js";
import { runTurn, type TurnResult } from "../agents/turn.js";
import type { TrustedReader } from "../config/trusted.js";
import type { FactoryEvents } from "../events.js";
import { runQualityGate, scanSecrets } from "../gate/gate.js";
import { branchName, createWorktree, gitEvidence, type GitEvidence, type Worktree } from "../git/worktrees.js";
import { factoryComment, type GithubPort } from "../github/port.js";
import type { Issue, Project, Run, RunPatch, Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { gateFingerprint } from "./fingerprint.js";
import { resolveGate } from "./gates.js";
import { diffHardRuleHits } from "./hard-rules.js";
import { RunMachine, TransitionError, type Evidence } from "./transitions.js";

export const RUNS_DIR = join(".factory", "runs");
export const DEFAULT_PORT_BASE = 4700;
const LEASE_TTL_MS = 15 * 60_000;
const LEASE_RENEW_MS = 60_000;

/**
 * Where approving a waiting gate sends the run. Triage goes straight to build until the spec
 * critic exists; review stays in review until reviews are automated (phase 3).
 */
export const APPROVE_TARGET: Partial<Record<Gate, RunState>> = {
  triage: "build",
  review: "review",
};

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
  /** How often to check for cancellation and renew the lease while a stage runs. */
  watchMs?: number;
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
 * The draft PR description from the builder's hand-over: a short brief for the human reviewer first,
 * with the implementation notes (useful to reviewing agents, noisy for people) collapsed below it.
 */
export function prBody(buildBody: string, issueNumber: number, unsafe = false): string {
  const parts: string[] = [];
  if (unsafe) {
    parts.push("> [!WARNING]\n> Built with `--unsafe`: hard rules (protected paths, new dependencies, secret files, deletions) were lifted for this run.");
  }
  const summary = section(buildBody, "summary");
  const testing = section(buildBody, "testing");
  const details = section(buildBody, "details");
  if (summary) parts.push(`## What\n${summary}`);
  if (testing) parts.push(`## How it was tested\n${testing}`);
  // Blank lines around the content so GitHub renders the markdown inside <details>.
  if (details) parts.push(`<details><summary>Implementation details</summary>\n\n${details}\n\n</details>`);
  parts.push(`Closes #${issueNumber}`);
  return `${parts.join("\n\n")}\n`;
}

/**
 * Moves runs through triage -> build -> quality gate, one stage at a time, until a run is parked,
 * finished, rate limited, or reaches a stage that is not automated yet. Every state change goes
 * through RunMachine; the driver only gathers evidence and decides which edge to try.
 */
export class PipelineDriver {
  private readonly machine: RunMachine;
  private readonly run: CommandRunner;
  /** Aborted when the run being driven is cancelled or this worker loses its lease. */
  private signal?: AbortSignal;

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
    // One transaction, so two `factory run` calls at once cannot both create a run.
    return store.transaction(() => {
      const active = store
        .listRuns({ project_id: project.id, states: [...ACTIVE, "needs_info", "needs_human"] })
        .find((r) => r.issue_number === issueNumber);
      if (active) return active;
      return store.createRun({ project_id: project.id, title: issue.title, issue_number: issueNumber, unsafe: options.unsafe });
    });
  }

  /** Send a run that was waiting for the author's answers back to triage. */
  retriage(runId: string, reason = "triage again with the current issue text"): Run {
    const run = this.load(runId);
    if (run.state !== "needs_info") throw new Error(`run ${runId} is ${run.state}, not waiting for information`);
    this.machine.transition(runId, "triage", { reason });
    this.deps.events?.emit({ type: "run:state", runId, from: run.state, to: "triage", reason });
    return this.load(runId);
  }

  async drive(runId: string): Promise<DriveOutcome> {
    const { store, owner } = this.deps;
    if (!store.acquireLease(runId, owner, LEASE_TTL_MS)) {
      const run = store.getRun(runId);
      return { kind: "stopped", state: run?.state ?? "failed", reason: `run is being worked on by ${run?.lease_owner}` };
    }
    this.closeOrphanedAgents(runId);

    // Watch the run while a stage works on it: a human may cancel it from another process, or
    // this worker may lose its lease. Either way the running agent or check must stop now, not
    // when it finishes on its own.
    const controller = new AbortController();
    this.signal = controller.signal;
    let renewedAt = Date.now();
    const watch = setInterval(() => {
      const run = store.getRun(runId);
      if (!run || isTerminal(run.state) || run.lease_owner !== owner) return controller.abort();
      if (Date.now() - renewedAt >= LEASE_RENEW_MS) {
        if (!store.acquireLease(runId, owner, LEASE_TTL_MS)) return controller.abort();
        renewedAt = Date.now();
      }
    }, this.deps.watchMs ?? 2000);
    watch.unref();
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
      clearInterval(watch);
      this.signal = undefined;
      store.releaseLease(runId, owner);
    }
  }

  /**
   * Agent rows still marked running when a worker takes the lease belong to a worker that died
   * (crash, Ctrl+C). Close them so nothing treats their stale pid as a live agent.
   */
  private closeOrphanedAgents(runId: string): void {
    for (const agent of this.deps.store.listAgentRuns(runId)) {
      if (agent.status === "running") {
        this.deps.store.finishAgentRun(agent.id, { status: "error", excerpt: `${agent.excerpt ?? ""}\nagent was orphaned: the factory process stopped`.trim() });
      }
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
            "Add tests, run the checks, commit (do not push), then write the output file.",
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
      validate: (verdict) =>
        verdict.header.STATUS === "READY" ? this.handOverProblems(worktree, git, verdict.header.COMMIT, join(dir, `round-${run.build_iterations + 1}`)) : [],
    });
    if (turn.status !== "ok") return this.agentTrouble(run, "builder", turn);

    if (turn.verdict.header.STATUS === "BLOCKED") {
      const blocker = section(turn.verdict.body, "blocker") ?? "the builder reported BLOCKED without details";
      return this.escalate(run, `builder is blocked: ${blocker}`);
    }
    const pr = this.publish(worktree, issue, turn.verdict.body, run.unsafe);
    this.move(run, "gate", "builder handed over", { commit: turn.verdict.header.COMMIT }, runEvidence(dir, run.build_iterations + 1, git), {
      pr_number: pr,
    });
    return undefined;
  }

  /**
   * Push the branch (never forced) and make sure a draft PR exists. Done by the engine, after the
   * secret scan, so nothing the builder committed reaches GitHub unchecked.
   */
  private publish(worktree: Worktree, issue: Issue, buildBody: string, unsafe: boolean): number {
    const pushed = this.run("git", ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${worktree.branch}`], { cwd: worktree.path });
    if (pushed.code !== 0) throw new Error(`git push failed: ${pushed.stderr || pushed.stdout}`);
    const existing = this.deps.github.findPullRequest(worktree.branch);
    if (existing !== undefined) return existing;
    return this.deps.github.createDraftPullRequest({
      head: worktree.branch,
      base: this.defaultBranch,
      title: issue.title,
      body: prBody(buildBody, issue.number, unsafe),
    });
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
      signal: this.signal,
    });
    const git = gitEvidence(worktree, this.defaultBranch, this.run);
    const fingerprint = gateFingerprint(result, worktree.path);
    const evidence: Evidence = { ...runEvidence(dir, round, git), gateFingerprint: () => fingerprint };

    if (result.passed) {
      // The same facts the gate->review guard needs: the pass is for HEAD, nothing changed since,
      // and it is pushed. Checks that leave the tree dirty or a commit made meanwhile show up here.
      const problems: string[] = [];
      if (git.head() !== result.head) problems.push("HEAD changed after the gate ran");
      if (!git.isClean()) problems.push("the checks left uncommitted changes in the worktree");
      if (!git.isPushed()) problems.push("the checked commit is not pushed");
      if (problems.length) return this.escalate(run, `quality gate passed but ${problems.join("; ")}`);
      // Reviews are not automated yet (phase 3): a human looks at the draft PR, told about any hard rule the diff trips.
      let hits: string[];
      try {
        hits = this.hardRuleHits(run, worktree, result.head);
      } catch (err) {
        // Without the check nobody knows what the diff touches: a human decides.
        return this.escalate(run, `quality gate passed but the hard-rule check failed: ${(err as Error).message}`);
      }
      const reasons = ["quality gate passed; reviews are not automated yet"];
      if (hits.length) reasons.push(`${run.unsafe ? "hard rules lifted by --unsafe" : "hard rules"}: ${hits.join("; ")}`);
      this.move(run, "needs_human", reasons.join("; "), { round, hardRuleHits: hits }, undefined, { waiting_gate: "review" });
      return undefined;
    }
    try {
      this.move(run, "build", `quality gate failed (round ${round})`, { round }, evidence);
    } catch (err) {
      // Only a stall or the loop cap is an expected stop here; anything else is reported as the error it is.
      if (!(err instanceof TransitionError) || this.load(run.id).state !== "gate") throw err;
      if (err.stall) {
        const { fingerprint, rounds, files } = err.stall;
        return this.escalate(run, err.stall.reason, { stalled: "quality gate", fingerprint, rounds, files });
      }
      if (!err.problems.some((p) => p.includes("cap reached"))) throw err;
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

  /**
   * Hard rules the branch trips against where it left the default branch. The scope a deletion is
   * checked against is the issue plus triage's reading of it.
   */
  private hardRuleHits(run: Run, worktree: Worktree, head: string): string[] {
    const issue = this.issueOf(run);
    const scope = [issue.title, issue.body, ...this.triageScope(this.runDir(run)).map((s) => s.body)].join("\n");
    return diffHardRuleHits({ cwd: worktree.path, defaultBranch: this.defaultBranch, config: this.deps.config, scope, head, run: this.run });
  }

  /** The risk triage gave this run, once triage has run. */
  private triageRisk(run: Run): "LOW" | "MEDIUM" | "HIGH" | undefined {
    const path = join(this.runDir(run), "triage.md");
    if (!existsSync(path)) return undefined;
    return parseVerdict("triage", readFileSync(path, "utf8")).header.RISK;
  }

  private agentBase(run: Run, role: PromptRole & AgentRole, cwd: string) {
    const { config, timeouts } = this.deps;
    return {
      runId: run.id,
      role,
      // Triage itself runs before there is a risk, so it never gets the high-risk settings.
      ...resolveModel(config, { role, risk: role === "triage" ? undefined : this.triageRisk(run) }),
      cwd,
      logDir: join(this.runDir(run), "logs"),
      signal: this.signal,
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
    // Only decisions made since the builder last ran were meant for it (not, say, the triage approval).
    const lastBuild = this.deps.store.listAgentRuns(run.id).filter((a) => a.role === "builder").at(-1)?.started_at ?? "";
    const human = this.deps.store
      .listDecisions(run.id)
      .filter((d) => d.actor === "human" && d.created_at >= lastBuild)
      .at(-1);
    if (human) parts.push("", `A human sent this back to you with this comment: ${human.comment}`);
    if (parts.length === 0) parts.push("Continue where you stopped and finish the hand-over.");
    parts.push("", `Output file: \`${outputFile}\``);
    return parts.join("\n").trim() + "\n";
  }

  /** The hand-over must be the checked-out commit, fully committed, with no secrets in any new commit. */
  private handOverProblems(worktree: Worktree, git: GitEvidence, commit: string, reportDir: string): string[] {
    const problems: string[] = [];
    const head = git.head();
    if (commit !== head) problems.push(`COMMIT ${commit.slice(0, 7)} is not HEAD (${head.slice(0, 7)})`);
    if (!git.isClean()) problems.push("the worktree has uncommitted changes");
    if (git.commitsAhead() < 1) problems.push(`the branch has no commits ahead of origin/${this.defaultBranch}`);
    const secrets = scanSecrets({ worktreePath: worktree.path, defaultBranch: this.defaultBranch, reportDir }, this.run);
    for (const hit of secrets.hits) {
      problems.push(`possible secret in ${hit.file}:${hit.line} (${hit.rule}): remove it from the unpushed commits`);
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

  private escalate(run: Run, reason: string, data?: unknown): StepResult {
    this.move(run, "needs_human", reason, data);
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
