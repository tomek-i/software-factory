import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  isBlocking,
  isTerminal,
  isTrustedAuthor,
  parseLessons,
  parseVerdict,
  REVIEW_LENSES,
  resolveModel,
  type AgentRole,
  type Finding,
  type FactoryConfig,
  type Gate,
  type GateMode,
  type ParsedVerdict,
  type ReviewLens,
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
import { factoryComment, type GithubPort, type PullRequestState } from "../github/port.js";
import type { Issue, Project, Run, RunEvent, RunPatch, Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { gateFingerprint } from "./fingerprint.js";
import { resolveGate, type GateInput } from "./gates.js";
import { changeReport, diffHardRuleHits, freshBase } from "./hard-rules.js";
import { RunMachine, TransitionError, type Evidence } from "./transitions.js";

export const RUNS_DIR = join(".factory", "runs");
export const DEFAULT_PORT_BASE = 4700;
const LEASE_TTL_MS = 15 * 60_000;
const LEASE_RENEW_MS = 60_000;

/**
 * Where approving a waiting gate sends the run. Triage goes straight to build until the spec
 * critic exists. Approving the review gate moves on to capture; a run parked there before reviews
 * were automated (parked from the quality gate) gets its reviews instead. Approving the PR gate
 * moves on to merge (which marks the PR ready itself), and approving the merge gate lets the merge
 * stage merge the commit that was waiting.
 */
export function approveTarget(run: Pick<Run, "waiting_gate" | "parked_from">): RunState | undefined {
  switch (run.waiting_gate) {
    case "triage":
      return "build";
    case "review":
      return run.parked_from === "gate" ? "review" : "capture";
    case "pr":
    case "merge":
      return "merge";
    default:
      return undefined;
  }
}

/** The commit a run waiting at the merge gate is waiting on, recorded on the event that parked it. */
export function waitingCommit(events: RunEvent[]): string | undefined {
  const data = events.at(-1)?.data as { commit?: unknown } | null | undefined;
  return typeof data?.commit === "string" ? data.commit : undefined;
}

/** A lens's review file in a round folder. */
function reviewPath(roundDir: string, lens: ReviewLens): string {
  return join(roundDir, `review-${lens}.md`);
}

/** A lens's review in a round folder, if it exists and is valid. */
function readReview(roundDir: string, lens: ReviewLens): ParsedVerdict<"review"> | undefined {
  const path = reviewPath(roundDir, lens);
  if (!existsSync(path)) return undefined;
  try {
    return parseVerdict("review", readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A verdict file, if it exists, parses, and passes `validate`. */
function readValid<K extends VerdictKind>(kind: K, path: string, validate: (verdict: ParsedVerdict<K>) => string[]): ParsedVerdict<K> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const verdict = parseVerdict(kind, readFileSync(path, "utf8"));
    return validate(verdict).length === 0 ? verdict : undefined;
  } catch {
    return undefined;
  }
}

export interface LensReview {
  lens: ReviewLens;
  verdict: ParsedVerdict<"review">;
}

/** A critical or major finding as the verifier sees it, with an id unique across all lenses. */
export interface BlockingFinding {
  lens: ReviewLens;
  finding: Finding;
}

/**
 * Every lens's blocking findings. Reviewers are told to start ids with their lens, but if two lenses
 * still use the same id, both get the lens in front so the verifier can name each one.
 */
export function blockingFindings(reviews: LensReview[]): BlockingFinding[] {
  const all = reviews.flatMap(({ lens, verdict }) => verdict.findings.filter(isBlocking).map((finding) => ({ lens, finding })));
  const count = new Map<string, number>();
  for (const { finding } of all) count.set(finding.id, (count.get(finding.id) ?? 0) + 1);
  return all.map(({ lens, finding }) => (count.get(finding.id)! > 1 ? { lens, finding: { ...finding, id: `${lens}/${finding.id}` } } : { lens, finding }));
}

/**
 * The verifier's `## Refuted` lines: `- <id>: <why>`, top-level bullets only (an indented bullet
 * belongs to the reason above it). Reviewers may use any text as an id, so the `known` ids are tried
 * first, longest first; otherwise the id is everything before the first ": ".
 */
export function refutedFindings(body: string, known: string[] = []): { id: string; reason: string }[] {
  const text = section(body, "refuted") ?? "";
  const ids = [...known].sort((a, b) => b.length - a.length);
  return text.split(/\r?\n/).flatMap((line) => {
    const item = /^[-*]\s+(.+)$/.exec(line)?.[1];
    if (!item) return [];
    for (const id of ids) {
      const match = new RegExp(`^\`?${escapeRegExp(id)}\`?\\s*:\\s*(.+)$`).exec(item);
      if (match) return [{ id, reason: match[1]!.trim() }];
    }
    const match = /^`?(.+?)`?\s*:\s+(.+)$/.exec(item);
    return match ? [{ id: match[1]!, reason: match[2]!.trim() }] : [];
  });
}

/** One line of run history for an agent: long reasons are cut so one cannot crowd out the rest. */
function clip(text: string, max = 500): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The verifier must judge every blocking finding exactly once: confirmed (in its findings) or
 * refuted. It may confirm one finding of its own, `verifier-*`, when something tried to steer it.
 */
export function verifyProblems(verdict: ParsedVerdict<"verify">, blocking: BlockingFinding[]): string[] {
  const known = new Set(blocking.map((b) => b.finding.id));
  const confirmed = verdict.findings.map((f) => f.id);
  const refuted = refutedFindings(verdict.body, [...known]).map((r) => r.id);
  const problems: string[] = [];
  for (const f of verdict.findings) {
    if (!isBlocking(f)) problems.push(`confirmed finding ${f.id} must be critical or major; refute it if it is only minor`);
  }
  for (const id of confirmed) if (!known.has(id) && !id.startsWith("verifier-")) problems.push(`confirmed finding ${id} is not one of the findings to verify`);
  for (const id of refuted) if (!known.has(id)) problems.push(`refuted finding ${id} is not one of the findings to verify`);
  const judged = [...confirmed, ...refuted];
  const twice = [...new Set(judged.filter((id, i) => judged.indexOf(id) !== i))];
  if (twice.length) problems.push(`judged more than once: ${twice.join(", ")}`);
  const missing = [...known].filter((id) => !judged.includes(id));
  if (missing.length) problems.push(`not judged (confirm or refute each): ${missing.join(", ")}`);
  return problems;
}

/** Where a finding points, e.g. ` (src/a.ts:3)`. */
function findingPlace(f: Finding): string {
  return f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
}

/**
 * The PR description's review notes: minor findings and nits per lens, the blocking findings the
 * verifier refuted (with why), and any it confirmed that are still open because the run stopped for
 * a human (a stall or the review round cap). Undefined when there is nothing to note.
 */
export function reviewNotes(reviews: LensReview[], verified?: ParsedVerdict<"verify">): string | undefined {
  const parts: string[] = [];
  if (verified?.header.VERDICT === "CONFIRMED") {
    parts.push(`**Confirmed by the verifier, not fixed**\n${verified.findings.map((f) => `- ${f.severity}: ${f.claim}${findingPlace(f)}`).join("\n")}`);
  }
  for (const { lens, verdict } of reviews) {
    const minor = verdict.findings.filter((f) => !isBlocking(f));
    if (minor.length) parts.push(`**${lens}**\n${minor.map((f) => `- ${f.severity}: ${f.claim}${findingPlace(f)}`).join("\n")}`);
  }
  if (verified) {
    const byId = new Map(blockingFindings(reviews).map((b) => [b.finding.id, b]));
    const refuted = refutedFindings(verified.body, [...byId.keys()]).map(({ id, reason }) => {
      const b = byId.get(id);
      return b ? `- ${b.lens} ${b.finding.severity}: ${b.finding.claim}${findingPlace(b.finding)}\n  Refuted: ${reason}` : `- ${id}: ${reason}`;
    });
    if (refuted.length) parts.push(`**Refuted by the verifier**\n${refuted.join("\n")}`);
  }
  return parts.length ? `## Review notes\nLeft for you to judge.\n\n${parts.join("\n\n")}` : undefined;
}

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
    // Every lens that wrote a review this round; which lenses had to run is the review stage's business.
    reviews: () => REVIEW_LENSES.flatMap((lens) => readReview(join(runDir, `round-${round}`), lens) ?? []),
    git,
  };
}

/** The `- ` bullets of a section's text. */
function bullets(text: string | undefined): string[] {
  return (text ?? "").split(/\r?\n/).flatMap((line) => /^[-*]\s+(.+)$/.exec(line.trim())?.[1] ?? []);
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
export function prBody(buildBody: string, issueNumber: number, unsafe = false, notes?: string): string {
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
  if (notes) parts.push(notes.trim());
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
      case "review":
        return this.review(run);
      case "capture":
        return this.capture(run);
      case "pr":
        return this.pr(run);
      case "merge":
        return this.merge(run);
      case "learn":
        return this.learn(run);
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
        verdict.header.STATUS === "READY" ? this.handOverProblems(worktree, git, verdict.header.COMMIT, join(dir, `round-${run.round + 1}`)) : [],
    });
    if (turn.status !== "ok") return this.agentTrouble(run, "builder", turn);

    if (turn.verdict.header.STATUS === "BLOCKED") {
      const blocker = section(turn.verdict.body, "blocker") ?? "the builder reported BLOCKED without details";
      return this.escalate(run, `builder is blocked: ${blocker}`);
    }
    const pr = this.publish(worktree, issue, turn.verdict.body, run.unsafe);
    this.move(run, "gate", "builder handed over", { commit: turn.verdict.header.COMMIT }, runEvidence(dir, run.round + 1, git), {
      pr_number: pr,
    });
    return undefined;
  }

  /**
   * Push the branch (never forced) and make sure a draft PR exists. Done by the engine, after the
   * secret scan, so nothing the builder committed reaches GitHub unchecked.
   */
  private publish(worktree: Worktree, issue: Issue, buildBody: string, unsafe: boolean): number {
    this.push(worktree);
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
    const round = run.round;
    // Every entry into the gate starts a new round, so this folder should have no reviews yet. Should
    // one be left over anyway (runs from before the round counter), it is for another commit and must
    // not be reused for whatever this gate passes.
    for (const lens of REVIEW_LENSES) rmSync(reviewPath(join(dir, `round-${round}`), lens), { force: true });
    rmSync(join(dir, `round-${round}`, "verify.md"), { force: true });
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
      this.move(run, "review", `quality gate passed (round ${round})`, { round, commit: result.head }, evidence);
      return undefined;
    }
    return this.loopBack(run, `quality gate failed (round ${round})`, { round }, evidence, "quality gate", `quality gate still failing after round ${round}`, (reason, data) =>
      this.escalate(run, reason, data),
    );
  }

  /**
   * Send the run back to the builder along a loop edge. A stall or the loop's cap stops it there
   * instead, and `park` hands it to a human with the reason.
   */
  private loopBack(
    run: Run,
    reason: string,
    data: unknown,
    evidence: Evidence,
    loop: string,
    capReason: string,
    park: (reason: string, data?: Record<string, unknown>) => StepResult,
  ): StepResult {
    try {
      this.move(run, "build", reason, data, evidence);
    } catch (err) {
      // Only a stall or the loop cap is an expected stop here; anything else is reported as the error it is.
      if (!(err instanceof TransitionError) || this.load(run.id).state !== run.state) throw err;
      if (err.stall) {
        const { fingerprint, rounds, files } = err.stall;
        return park(err.stall.reason, { stalled: loop, fingerprint, rounds, files });
      }
      if (!err.problems.some((p) => p.includes("cap reached"))) throw err;
      return park(`${capReason}: ${err.problems.join("; ")}`);
    }
    return undefined;
  }

  /**
   * Run the review lenses in parallel on the commit that passed the gate, then decide the review
   * gate. A lens that already wrote a valid review for this round (e.g. before a usage limit) is
   * not run again. Blocking findings go to the verifier: the ones it confirms send the run back to
   * the builder; minor findings and nits never do.
   */
  private async review(run: Run): Promise<StepResult> {
    const dir = this.runDir(run);
    const issue = this.issueOf(run);
    const worktree = this.worktreeOf(run);
    const round = run.round;
    const roundDir = join(dir, `round-${round}`);
    const git = gitEvidence(worktree, this.defaultBranch, this.run);
    const commit = parseVerdict("checks", readFileSync(join(roundDir, "checks.md"), "utf8")).header.COMMIT;
    if (git.head() !== commit) {
      return this.escalate(run, `HEAD is ${git.head().slice(0, 7)} but the quality gate passed ${commit.slice(0, 7)}; reviews only look at the gated commit`);
    }
    let base: string;
    try {
      base = freshBase(worktree.path, this.defaultBranch, commit, this.run);
    } catch (err) {
      return this.escalate(run, `could not find where the branch left ${this.defaultBranch}: ${(err as Error).message}`);
    }

    const lenses = this.reviewLenses(run);
    const pending = lenses.filter((lens) => !readReview(roundDir, lens));
    // The engine writes the change for the reviewers and the verifier, who get no shell (see permissionProfile).
    const changeFile = join(roundDir, "change.diff");
    try {
      mkdirSync(roundDir, { recursive: true });
      writeFileSync(changeFile, changeReport(worktree.path, base, commit, this.run));
    } catch (err) {
      return this.escalate(run, `could not prepare the change for the reviewers: ${(err as Error).message}`);
    }
    const turns = await Promise.all(pending.map((lens) => this.reviewTurn(run, issue, worktree, lens, round, base, commit, changeFile)));
    // A usage limit stops the run where it is; the reviews already written are kept for next time.
    const limited = turns.find((t) => t.turn.status === "failed" && t.turn.agent.outcome.kind === "rate_limited");
    if (limited && limited.turn.status !== "ok") return this.agentTrouble(run, `reviewer (${limited.lens})`, limited.turn);
    const troubles = turns.flatMap((t) => (t.turn.status === "ok" ? [] : [{ lens: t.lens, turn: t.turn }]));
    if (troubles.length === 1) return this.agentTrouble(run, `reviewer (${troubles[0]!.lens})`, troubles[0]!.turn);
    if (troubles.length > 1) {
      if (this.load(run.id).state !== run.state) return undefined; // cancelled while the reviewers ran
      // Every failed lens is named; the lenses that did write a review are kept for the next attempt.
      return this.escalate(run, troubles.map((t) => this.troubleReason(`reviewer (${t.lens})`, t.turn)).join("; "));
    }

    const reviews = lenses.map((lens) => ({ lens, verdict: readReview(roundDir, lens)! }));
    const summary = `reviews: ${reviews
      .map(({ lens, verdict }) => {
        const blocking = verdict.findings.filter(isBlocking).length;
        return `${lens} ${verdict.header.VERDICT}${blocking ? ` (${blocking} blocking)` : ""}`;
      })
      .join(", ")}`;
    this.info(run, summary);

    let hits: string[];
    try {
      hits = this.hardRuleHits(run, worktree, commit);
    } catch (err) {
      // Without the check nobody knows what the diff touches: a human decides.
      return this.escalate(run, `${summary}; the hard-rule check failed: ${(err as Error).message}`);
    }
    const lifted = run.unsafe && hits.length ? [`hard rules lifted by --unsafe: ${hits.join("; ")}`] : [];
    const held = run.unsafe ? [] : hits.map((h) => `hard rule: ${h}`);

    let verified: ParsedVerdict<"verify"> | undefined;
    const outcome = [summary];
    if (reviews.some(({ verdict }) => verdict.header.VERDICT === "CHANGES")) {
      const blocking = blockingFindings(reviews);
      const verifyFile = join(roundDir, "verify.md");
      const validate = (verdict: ParsedVerdict<"verify">) => verifyProblems(verdict, blocking);
      // A valid judgement from an earlier attempt at this round (e.g. before a usage limit) stands.
      verified = readValid("verify", verifyFile, validate);
      if (!verified) {
        const turn = await this.verifyTurn(run, issue, worktree, blocking, { outputFile: verifyFile, validate, base, commit, changeFile });
        if (turn.status !== "ok") return this.agentTrouble(run, "verifier", turn);
        verified = turn.verdict;
      }
      if (verified.header.VERDICT === "CONFIRMED") {
        const confirmed = `the verifier confirmed ${verified.findings.length} of ${blocking.length} blocking findings`;
        this.info(run, confirmed);
        // A stall or the cap stops the run at the review gate, where a human may approve it as is
        // (`factory approve`), so they see the hard rules and the PR lists the open findings.
        const found = verified;
        return this.loopBack(
          run,
          `${confirmed} (round ${round})`,
          { round },
          runEvidence(dir, round, git),
          "reviews",
          `reviews still have confirmed findings after round ${round}`,
          (reason, data) => {
            this.publishReviewNotes(run, reviews, found);
            return this.waitForHuman(run, "review", [summary, reason, ...held, ...lifted], data);
          },
        );
      }
      outcome.push(`the verifier refuted all ${blocking.length} blocking findings`);
      this.info(run, outcome.at(-1)!);
    }
    this.publishReviewNotes(run, reviews, verified);
    const mode = this.deps.config.gates.review;
    const gate = resolveGate({ mode, agentDecision: { decision: "PROCEED" }, hardRuleHits: hits, unsafe: run.unsafe });
    if (gate.outcome === "wait_human") return this.waitForHuman(run, "review", [...outcome, ...gate.reasons, ...lifted]);
    for (const line of lifted) this.info(run, line);
    this.recordProceed(run, "review", mode, [...outcome, ...lifted].join("; "), commit);
    this.move(run, "capture", `reviews clear (round ${round})`, { round, commit }, runEvidence(dir, round, git));
    return undefined;
  }

  /** Screenshots and a walkthrough for UI changes are not automated yet, so capture passes straight on. */
  private capture(run: Run): StepResult {
    this.move(run, "pr", "capture (screenshots) is not automated yet");
    return undefined;
  }

  /** The PR gate, then take the draft PR out of draft so it reads as ready for a human's review. */
  private pr(run: Run): StepResult {
    if (run.pr_number === null) return this.escalate(run, "the run has no pull request");
    const mode = this.deps.config.gates.pr;
    const gate = resolveGate({ mode, agentDecision: { decision: "PROCEED" }, hardRuleHits: [], unsafe: run.unsafe });
    if (gate.outcome === "wait_human") return this.waitForHuman(run, "pr", gate.reasons);
    const { github } = this.deps;
    if (github.pullRequestState(run.pr_number).draft) github.markReady(run.pr_number);
    const git = gitEvidence(this.worktreeOf(run), this.defaultBranch, this.run);
    this.recordProceed(run, "pr", mode, `PR #${run.pr_number} marked ready`, git.head());
    this.move(run, "merge", `PR #${run.pr_number} is ready`, undefined, runEvidence(this.runDir(run), run.round, git));
    return undefined;
  }

  /**
   * Merge the run's PR: bring the branch up to date with the default branch, run the quality gate
   * again if that changed it, decide the merge gate, then merge exactly the commit that passed. A
   * conflict or a failing gate goes back to the builder, which costs a review round.
   */
  private async merge(run: Run): Promise<StepResult> {
    const { github, config } = this.deps;
    const number = run.pr_number;
    if (number === null) return this.escalate(run, "the run has no pull request to merge");
    const pr = github.pullRequestState(number);
    // Merged or closed by a human meanwhile: that settles the run.
    if (pr.state !== "open") return this.closedOnGithub(run, pr);
    // Ready before anyone is asked to approve the merge (approving the PR gate comes straight here).
    if (pr.draft) github.markReady(number);

    const dir = this.runDir(run);
    const worktree = this.worktreeOf(run);
    const round = run.round;
    const resyncDir = join(dir, `round-${round}`, "resync");
    const git = gitEvidence(worktree, this.defaultBranch, this.run);
    const evidence = runEvidence(dir, round, git);
    const backToBuild = (reason: string, data: Record<string, unknown>) =>
      this.loopBack(run, reason, { round, ...data }, evidence, "merge", `still cannot merge after round ${round}`, (why) => this.escalate(run, why));

    const conflicts = this.resync(worktree, resyncDir);
    if (conflicts) return backToBuild(`merging ${this.defaultBranch} into the branch conflicts in ${conflicts.join(", ")}`, { conflicts });
    let head = git.head();
    if (!this.passedOn(dir, round, head)) {
      const result = await runQualityGate({
        runId: run.id,
        worktreePath: worktree.path,
        defaultBranch: this.defaultBranch,
        checks: config.checks,
        roundDir: resyncDir,
        run: this.run,
        events: this.deps.events,
        signal: this.signal,
      });
      if (!result.passed) return backToBuild(`quality gate failed after merging ${this.defaultBranch} (round ${round})`, { resync: true });
      head = git.head();
      if (head !== result.head || !git.isClean()) return this.escalate(run, "the worktree changed while the quality gate ran after merging the default branch");
    }
    // Whatever a human approves, or GitHub merges, must be what the PR shows; this also catches up
    // on a push that failed in an earlier attempt.
    if (!git.isPushed()) this.push(worktree);

    if (!this.approvalCovers(run, worktree, head)) {
      let hits: string[];
      try {
        hits = this.hardRuleHits(run, worktree, head);
      } catch (err) {
        return this.escalate(run, `the hard-rule check failed: ${(err as Error).message}`);
      }
      const mode = config.gates.merge;
      const lifted = run.unsafe && hits.length ? [`hard rules lifted by --unsafe: ${hits.join("; ")}`] : [];
      let agentDecision: GateInput["agentDecision"];
      // Hard rules need a human whatever the approver says, so it is only asked when it can decide.
      if (mode === "auto" && (run.unsafe || hits.length === 0)) {
        const turn = await this.approverTurn(run, worktree, head);
        if (turn.status !== "ok") return this.agentTrouble(run, "approver", turn);
        agentDecision = { decision: turn.verdict.header.DECISION, reasons: bullets(section(turn.verdict.body, "reasons")) };
      }
      const gate = resolveGate({ mode, agentDecision, hardRuleHits: hits, unsafe: run.unsafe });
      if (gate.outcome === "wait_human") return this.waitForHuman(run, "merge", [...gate.reasons, ...lifted], { commit: head });
      this.recordProceed(run, "merge", mode, [mode === "auto" ? "the approver said PROCEED" : "gate is set to always", ...lifted].join("; "), head);
    }
    return this.mergePullRequest(run, number, head, git);
  }

  /** Merge exactly `head`, which passed the quality gate and is what GitHub has, then move on to learn. */
  private mergePullRequest(run: Run, number: number, head: string, git: GitEvidence): StepResult {
    const { github } = this.deps;
    const problems: string[] = [];
    if (!this.passedOn(this.runDir(run), run.round, head)) problems.push(`no passing quality gate on ${head.slice(0, 7)}`);
    if (!git.isClean()) problems.push("the worktree has uncommitted changes");
    if (!git.isPushed()) problems.push(`${head.slice(0, 7)} is not pushed`);
    if (problems.length) return this.escalate(run, `will not merge PR #${number}: ${problems.join("; ")}`);
    try {
      if (github.pullRequestState(number).draft) github.markReady(number);
      // The last moment to notice a cancel (or a lost lease) before something that cannot be undone.
      if (this.load(run.id).state !== run.state) return undefined;
      if (this.signal?.aborted) return { kind: "stopped", state: run.state, reason: "this worker lost the run before merging" };
      // --match-head-commit: GitHub refuses if the PR's head is anything but the commit that passed.
      github.mergePullRequest(number, head);
    } catch (err) {
      return this.escalate(run, `could not merge PR #${number}: ${(err as Error).message}`);
    }
    const merged = github.pullRequestState(number);
    this.move(run, "learn", `merged PR #${number}`, { pr: number, commit: head, mergeCommit: merged.mergeCommit }, {
      ...runEvidence(this.runDir(run), run.round, git),
      pullRequest: () => merged,
    });
    return undefined;
  }

  /**
   * After the merge, a learner looks back at a run that did not go smoothly and proposes lessons,
   * stored for a human to approve (`factory lessons`); nothing reaches `.factory/lessons.md` here.
   * The merge has happened, so nothing in this stage may hold the run up: a learner that fails, hits
   * the usage limit or writes something malformed only means no lessons from this run, with a note.
   */
  private async learn(run: Run): Promise<StepResult> {
    const worth = this.learnReasons(run);
    // Saves usage: a run that went through cleanly has nothing to teach.
    if (worth.length === 0) {
      this.move(run, "done", "nothing to learn: one round, no failed checks or blocking findings, no human stepped in");
      return undefined;
    }
    let turn: TurnResult<"learn">;
    try {
      turn = await this.learnerTurn(run, worth);
    } catch (err) {
      return this.skipLessons(run, `the learner could not start: ${(err as Error).message}`);
    }
    if (this.load(run.id).state !== run.state) return undefined; // cancelled while the learner ran
    if (turn.status !== "ok") {
      const { outcome } = turn.agent;
      // The run is finished, so there is nothing to continue after the reset: this run's lessons are skipped.
      const why =
        turn.status === "failed" && outcome.kind === "rate_limited"
          ? `usage limit reached${outcome.resetsAt ? ` (resets at ${outcome.resetsAt})` : ""}`
          : this.troubleReason("learner", turn);
      return this.skipLessons(run, why);
    }
    const lessons = parseLessons(turn.verdict.body);
    const { store } = this.deps;
    // One transaction, so a crash in between never stores the same proposals twice.
    store.transaction(() => {
      store.addLessons(run.id, lessons);
      const reason = lessons.length
        ? `${lessons.length} lesson${lessons.length > 1 ? "s" : ""} proposed; see \`factory lessons\``
        : "the learner proposed no lessons";
      this.move(run, "done", reason, { lessons: lessons.length });
    });
    return undefined;
  }

  /** Finish a merged run without lessons, saying why. */
  private skipLessons(run: Run, why: string): StepResult {
    this.info(run, `warning: no lessons from this run: ${why}`);
    this.move(run, "done", `lessons skipped: ${why}`, { warning: why });
    return undefined;
  }

  /**
   * Why a merged run is worth the learner's time. Empty for a run that went through in one round
   * with no failed check, no blocking finding and no human stepping in other than to approve a gate.
   */
  private learnReasons(run: Run): string[] {
    const dir = this.runDir(run);
    const reasons: string[] = [];
    if (run.round > 1) reasons.push(`it took ${run.round} rounds`);
    const failed = (v: ParsedVerdict<"checks">) => (v.header.GATE === "FAIL" ? [] : ["passed"]);
    for (let round = 1; round <= run.round; round++) {
      const roundDir = join(dir, `round-${round}`);
      for (const file of ["checks.md", "resync/checks.md"]) {
        if (readValid("checks", join(roundDir, file), failed)) reasons.push(`the quality gate failed (round-${round}/${file})`);
      }
      for (const lens of REVIEW_LENSES) {
        if (readReview(roundDir, lens)?.findings.some(isBlocking)) reasons.push(`the ${lens} review had blocking findings (round-${round}/review-${lens}.md)`);
      }
    }
    const events = this.deps.store.listEvents(run.id);
    for (const [i, event] of events.entries()) {
      if (event.to_state === "needs_info") reasons.push(`triage asked the author for more information: ${event.reason}`);
      // Waiting at a gate is routine; any other stop for a human is an escalation.
      if (event.to_state === "needs_human" && !event.reason.startsWith("waiting at ")) reasons.push(`escalated: ${clip(event.reason)}`);
      if (event.from_state !== "needs_human") continue;
      const gate = (event.data as { gate?: unknown } | null)?.gate;
      const parkedFrom = events.slice(0, i).findLast((e) => e.to_state === "needs_human")?.from_state ?? null;
      const approval = typeof gate === "string" && gate !== "escalation" && approveTarget({ waiting_gate: gate as Gate, parked_from: parkedFrom }) === event.to_state;
      if (!approval) reasons.push(`a human sent the run to ${event.to_state}: ${clip(event.reason)}`);
    }
    return reasons;
  }

  /** The learner reads the run's reports and history and proposes lessons in `learn.md`. */
  private async learnerTurn(run: Run, worth: string[]): Promise<TurnResult<"learn">> {
    const dir = this.runDir(run);
    const issue = this.issueOf(run);
    const outputFile = verdictPath(dir, "learn", run.round);
    // The merged branch's worktree is kept after the merge; the repo root will do if it was removed.
    const cwd = run.worktree_path && existsSync(run.worktree_path) ? run.worktree_path : this.deps.project.repo_path;
    const rounds = Array.from({ length: run.round }, (_, i) => join(dir, `round-${i + 1}`));
    const reports = [
      join(dir, "build.md"),
      ...rounds.flatMap((roundDir) => [
        join(roundDir, "checks.md"),
        ...REVIEW_LENSES.map((lens) => reviewPath(roundDir, lens)),
        join(roundDir, "verify.md"),
        join(roundDir, "resync", "conflicts.md"),
        join(roundDir, "resync", "checks.md"),
      ]),
      join(dir, "approval.md"),
    ].filter((path) => existsSync(path));
    const { store } = this.deps;
    const events = store.listEvents(run.id).map((e) => `- ${e.from_state ?? "-"} -> ${e.to_state}: ${clip(e.reason)}`);
    const human = store
      .listDecisions(run.id)
      .filter((d) => d.actor === "human")
      .map((d) => `- ${d.gate}, ${d.outcome}: ${clip(d.comment)}`);
    const files = writeRoleFiles(dir, "learner", rolePrompt("learner", this.deps.read), permissionProfile("learner", { runDirFromCwd: relative(cwd, dir), outputFile }));
    return runTurn({
      run: this.deps.runAgent,
      kind: "learn",
      outputFile,
      agent: {
        ...this.agentBase(run, "learner", cwd),
        ...files,
        addDirs: [dir],
        prompt: renderTask({
          role: "learner",
          runId: run.id,
          runDir: dir,
          workDir: cwd,
          outputFile,
          issue: this.issueText(issue),
          trusted: isTrustedAuthor(this.deps.config, issue.author),
          lessons: this.lessons(),
          branch: run.branch ?? undefined,
          defaultBranch: this.defaultBranch,
          sections: [
            ...this.triageScope(dir),
            { title: "Why this run is worth a look", body: worth.map((w) => `- ${w}`).join("\n") },
            {
              title: "Run history",
              body: ["Events, oldest first (written by the engine; reasons may quote agents):", ...events, "", "Human decisions:", ...(human.length ? human : ["(none)"])].join("\n"),
            },
            { title: "Run files", body: reports.map((path) => `- \`${path}\``).join("\n") },
          ],
          instructions: [
            `PR #${run.pr_number} for issue #${issue.number} has been merged. Look back at how this run got there.`,
            "Read the run files and the history, then write the output file with the lessons you propose (often none).",
          ].join("\n"),
        }),
      },
    });
  }

  /** The run's PR was merged or closed on GitHub before the factory merged it. */
  private closedOnGithub(run: Run, pr: PullRequestState): StepResult {
    const done = this.machine.closeByPullRequest(run.id, pr, this.deps.owner);
    this.deps.events?.emit({ type: "run:state", runId: run.id, from: run.state, to: done.state, reason: this.lastReason(run.id) });
    return undefined;
  }

  /**
   * Merge the latest default branch into the run's branch (not pushed yet). On a conflict the merge
   * is undone and the conflicting files are returned, and listed in `resync/conflicts.md` for the builder.
   */
  private resync(worktree: Worktree, resyncDir: string): string[] | undefined {
    const git = (args: string[]) => this.run("git", args, { cwd: worktree.path });
    const conflictsFile = join(resyncDir, "conflicts.md");
    rmSync(conflictsFile, { force: true });
    // A failed re-gate from an earlier attempt would tell the builder about the wrong problem. A pass
    // is kept: it still proves its commit passed.
    const checksFile = join(resyncDir, "checks.md");
    if (readValid("checks", checksFile, (v) => (v.header.GATE === "FAIL" ? [] : ["passed"]))) rmSync(checksFile);
    const fetched = git(["fetch", "--quiet", "origin", this.defaultBranch]);
    if (fetched.code !== 0) throw new Error(`git fetch failed: ${fetched.stderr || fetched.stdout}`);
    const merged = git(["merge", "--no-edit", `origin/${this.defaultBranch}`]);
    if (merged.code === 0) return undefined;
    const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).stdout.split(/\r?\n/).filter(Boolean);
    // Without conflicts the merge never started (dirty worktree, no committer identity, ...): its own error says why.
    if (conflicts.length === 0) throw new Error(`git merge origin/${this.defaultBranch} failed: ${merged.stderr || merged.stdout}`);
    const aborted = git(["merge", "--abort"]);
    if (aborted.code !== 0) throw new Error(`git merge --abort failed: ${aborted.stderr || aborted.stdout}`);
    mkdirSync(resyncDir, { recursive: true });
    writeFileSync(conflictsFile, `Merging origin/${this.defaultBranch} conflicts in:\n\n${conflicts.map((f) => `- ${f}`).join("\n")}\n`);
    return conflicts;
  }

  /** Whether this round's quality gate, or its re-run after the re-sync, passed on `head`. */
  private passedOn(dir: string, round: number, head: string): boolean {
    const passed = (v: ParsedVerdict<"checks">) => (v.header.GATE === "PASS" && v.header.COMMIT === head ? [] : ["not a pass on HEAD"]);
    const roundDir = join(dir, `round-${round}`);
    return [join(roundDir, "checks.md"), join(roundDir, "resync", "checks.md")].some((path) => readValid("checks", path, passed));
  }

  /**
   * Whether a human's approval of the merge gate still covers `head`: nothing went back to the
   * builder since, and `head` is the approved commit or adds only merge commits (the engine's
   * re-syncs) on top of it. Any other change needs a fresh approval.
   */
  private approvalCovers(run: Run, worktree: Worktree, head: string): boolean {
    const events = this.deps.store.listEvents(run.id);
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
    if (this.run("git", ["merge-base", "--is-ancestor", approved, head], { cwd }).code !== 0) return false;
    // Along the branch's own line only: the commits a re-sync brings in from the default branch are not the branch's.
    const added = this.run("git", ["rev-list", "--first-parent", "--no-merges", `${approved}..${head}`], { cwd });
    return added.code === 0 && added.stdout.trim() === "";
  }

  /** The approver weighs the run's reports and the final diff, and says PROCEED or ESCALATE. */
  private async approverTurn(run: Run, worktree: Worktree, head: string): Promise<TurnResult<"approver">> {
    const dir = this.runDir(run);
    const issue = this.issueOf(run);
    const outputFile = verdictPath(dir, "approver", run.round);
    rmSync(outputFile, { force: true });
    const base = freshBase(worktree.path, this.defaultBranch, head, this.run);
    const changeFile = join(dir, "approval.diff");
    writeFileSync(changeFile, changeReport(worktree.path, base, head, this.run));
    const roundDir = join(dir, `round-${run.round}`);
    const reports = [
      join(dir, "build.md"),
      join(roundDir, "checks.md"),
      join(roundDir, "resync", "checks.md"),
      ...REVIEW_LENSES.map((lens) => reviewPath(roundDir, lens)),
      join(roundDir, "verify.md"),
    ].filter((path) => existsSync(path));
    const files = writeRoleFiles(dir, "approver", rolePrompt("approver", this.deps.read), permissionProfile("approver", { runDirFromCwd: relative(worktree.path, dir), outputFile }));
    return runTurn({
      run: this.deps.runAgent,
      kind: "approver",
      outputFile,
      agent: {
        ...this.agentBase(run, "approver", worktree.path),
        ...files,
        addDirs: [dir],
        prompt: renderTask({
          role: "approver",
          runId: run.id,
          runDir: dir,
          workDir: worktree.path,
          outputFile,
          issue: this.issueText(issue),
          trusted: isTrustedAuthor(this.deps.config, issue.author),
          lessons: this.lessons(),
          branch: worktree.branch,
          defaultBranch: this.defaultBranch,
          sections: [...this.triageScope(dir), { title: "Run files", body: reports.map((path) => `- \`${path}\``).join("\n") }],
          instructions: [
            `Decide whether PR #${run.pr_number} for issue #${issue.number} may be merged.`,
            `Base: \`${base}\` (where the branch left ${this.defaultBranch}). Final commit: \`${head}\`.`,
            `The commits and the full diff are in \`${changeFile}\`. Read the run files and the diff, then write the output file.`,
          ].join("\n"),
        }),
      },
    });
  }

  /** Push the run's branch (never forced). */
  private push(worktree: Worktree): void {
    const pushed = this.run("git", ["push", "--quiet", "-u", "origin", `HEAD:refs/heads/${worktree.branch}`], { cwd: worktree.path });
    if (pushed.code !== 0) throw new Error(`git push failed: ${pushed.stderr || pushed.stdout}`);
  }

  /** A gate let the run through without a human: record who decided and on which commit. */
  private recordProceed(run: Run, gate: Gate, mode: GateMode, comment: string, commit: string): void {
    this.deps.store.recordDecision({
      run_id: run.id,
      gate,
      mode,
      outcome: "proceed",
      actor: mode === "auto" ? "agent" : "system",
      comment: comment || `gate is set to ${mode}`,
      commit_sha: commit,
    });
  }

  /** The verifier checks this round's blocking findings against the code. */
  private verifyTurn(
    run: Run,
    issue: Issue,
    worktree: Worktree,
    blocking: BlockingFinding[],
    turn: { outputFile: string; validate: (verdict: ParsedVerdict<"verify">) => string[]; base: string; commit: string; changeFile: string },
  ): Promise<TurnResult<"verify">> {
    const dir = this.runDir(run);
    const { outputFile, validate, base, commit, changeFile } = turn;
    const files = writeRoleFiles(dir, "verifier", rolePrompt("verifier", this.deps.read), permissionProfile("verifier", { runDirFromCwd: relative(worktree.path, dir), outputFile }));
    const findings = blocking.map(({ lens, finding }) => ({ lens, ...finding }));
    return runTurn({
      run: this.deps.runAgent,
      kind: "verify",
      outputFile,
      validate,
      agent: {
        ...this.agentBase(run, "verifier", worktree.path),
        ...files,
        addDirs: [dir],
        prompt: renderTask({
          role: "verifier",
          runId: run.id,
          runDir: dir,
          workDir: worktree.path,
          outputFile,
          issue: this.issueText(issue),
          trusted: isTrustedAuthor(this.deps.config, issue.author),
          lessons: this.lessons(),
          branch: worktree.branch,
          defaultBranch: this.defaultBranch,
          sections: [
            ...this.triageScope(dir),
            { title: "Findings to verify", body: ["```json", JSON.stringify(findings, null, 2), "```"].join("\n") },
          ],
          instructions: [
            `Verify each of the ${blocking.length} findings above against the change on branch \`${worktree.branch}\`.`,
            `Base: \`${base}\` (where the branch left ${this.defaultBranch}). Commit under review: \`${commit}\`.`,
            `The commits and the full diff are in \`${changeFile}\`. Read it, then the code each finding points at, then write the output file.`,
          ].join("\n"),
        }),
      },
    });
  }

  /**
   * Rewrite the PR description with what the reviews leave for the human: minor findings and nits,
   * and the blocking findings the verifier refuted. Built from build.md each time, so it never stacks.
   */
  private publishReviewNotes(run: Run, reviews: LensReview[], verified: ParsedVerdict<"verify"> | undefined): void {
    if (run.pr_number === null) return;
    try {
      const build = parseVerdict("build", readFileSync(join(this.runDir(run), "build.md"), "utf8"));
      const notes = reviewNotes(reviews, verified);
      this.deps.github.updatePullRequest(run.pr_number, prBody(build.body, run.issue_number!, run.unsafe, notes));
    } catch (err) {
      // The notes are a convenience; the review files hold the same and `factory show` lists them.
      this.info(run, `could not add the review notes to PR #${run.pr_number}: ${(err as Error).message}`);
    }
  }

  /** `reviews.always`, plus `reviews.ui` when triage said the change touches the UI. */
  private reviewLenses(run: Run): ReviewLens[] {
    const { reviews } = this.deps.config;
    const path = join(this.runDir(run), "triage.md");
    const surfaces = existsSync(path) ? parseVerdict("triage", readFileSync(path, "utf8")).header.SURFACES : [];
    const wanted = new Set<ReviewLens>([...reviews.always, ...(surfaces.includes("ui") ? reviews.ui : [])]);
    return REVIEW_LENSES.filter((lens) => wanted.has(lens));
  }

  private async reviewTurn(
    run: Run,
    issue: Issue,
    worktree: Worktree,
    lens: ReviewLens,
    round: number,
    base: string,
    commit: string,
    changeFile: string,
  ) {
    const dir = this.runDir(run);
    const outputFile = reviewPath(join(dir, `round-${round}`), lens);
    const files = writeRoleFiles(
      dir,
      `reviewer-${lens}`,
      rolePrompt("reviewer", this.deps.read, lens),
      permissionProfile("reviewer", { runDirFromCwd: relative(worktree.path, dir), outputFile }),
    );
    const sections = this.triageScope(dir);
    const previous = this.previousReview(run, lens, round);
    if (previous) {
      sections.push({
        title: `Your findings from round ${previous.round}`,
        body: ["Check each of these first and say which are fixed.", "", "```json", JSON.stringify(previous.verdict.findings, null, 2), "```"].join("\n"),
      });
    }
    const turn = await runTurn({
      run: this.deps.runAgent,
      kind: "review",
      outputFile,
      agent: {
        ...this.agentBase(run, "reviewer", worktree.path, lens),
        role: `reviewer:${lens}`,
        ...files,
        addDirs: [dir],
        prompt: renderTask({
          role: "reviewer",
          lens,
          runId: run.id,
          runDir: dir,
          workDir: worktree.path,
          outputFile,
          issue: this.issueText(issue),
          trusted: isTrustedAuthor(this.deps.config, issue.author),
          lessons: this.lessons(),
          branch: worktree.branch,
          defaultBranch: this.defaultBranch,
          sections,
          instructions: [
            `Review the change on branch \`${worktree.branch}\` through the ${lens} lens.`,
            `Base: \`${base}\` (where the branch left ${this.defaultBranch}). Commit under review: \`${commit}\`.`,
            `The commits and the full diff are in \`${changeFile}\`. Read it, then the code around the change, then write the output file.`,
          ].join("\n"),
        }),
      },
    });
    return { lens, turn };
  }

  /** This lens's review from the latest earlier round that has one. */
  private previousReview(run: Run, lens: ReviewLens, round: number): { round: number; verdict: ParsedVerdict<"review"> } | undefined {
    for (let r = round - 1; r >= 1; r--) {
      const verdict = readReview(join(this.runDir(run), `round-${r}`), lens);
      if (verdict) return { round: r, verdict };
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

  private agentBase(run: Run, role: PromptRole & AgentRole, cwd: string, lens?: ReviewLens) {
    const { config, timeouts } = this.deps;
    return {
      runId: run.id,
      role,
      // Triage itself runs before there is a risk, so it never gets the high-risk settings.
      ...resolveModel(config, { role, lens, risk: role === "triage" ? undefined : this.triageRisk(run) }),
      cwd,
      logDir: join(this.runDir(run), "logs"),
      signal: this.signal,
      timeoutMs: timeouts?.[role] ?? (role === "builder" ? 90 * 60_000 : 20 * 60_000),
    };
  }

  /**
   * What the builder's resumed session is told: why the run came back (the failed gate's report or
   * the findings the verifier confirmed) and/or the human's instruction.
   */
  private builderFollowUp(run: Run, outputFile: string): string {
    const parts: string[] = [];
    const roundDir = join(this.runDir(run), `round-${run.round}`);
    const events = this.deps.store.listEvents(run.id);
    const last = events.findLastIndex((e) => e.to_state === "build");
    let back = events[last]?.from_state;
    // Sent back by a human: what failed is whatever made the run stop where it was parked.
    if (back === "needs_human") back = events.slice(0, last).findLast((e) => e.to_state === "needs_human")?.from_state;
    const checks = back === "gate" ? readValid("checks", join(roundDir, "checks.md"), (v) => (v.header.GATE === "FAIL" ? [] : ["passed"])) : undefined;
    const verify = back === "review" ? readValid("verify", join(roundDir, "verify.md"), (v) => (v.header.VERDICT === "CONFIRMED" ? [] : ["none confirmed"])) : undefined;
    // The merge stage clears conflicts.md before each re-sync, so one that exists is from the attempt that sent the run back.
    const conflicts = back === "merge" && existsSync(join(roundDir, "resync", "conflicts.md"));
    const resynced = back === "merge" && !conflicts ? readValid("checks", join(roundDir, "resync", "checks.md"), (v) => (v.header.GATE === "FAIL" ? [] : ["passed"])) : undefined;
    if (checks) {
      parts.push(`The quality gate failed in round ${run.round}. Its report:`, "", readFileSync(join(roundDir, "checks.md"), "utf8").trim(), "");
      parts.push("Fix the cause, run the checks yourself, commit and push, then write the output file again.");
    } else if (verify) {
      const { findings } = verify;
      parts.push(
        `The reviewers of round ${run.round} found problems, and a verifier confirmed these against the code:`,
        "",
        "```json",
        JSON.stringify(findings, null, 2),
        "```",
        "",
        "Fix each one (with a test where it fits), run the checks yourself, commit and push, then write the output file again.",
      );
    } else if (conflicts) {
      parts.push(
        readFileSync(join(roundDir, "resync", "conflicts.md"), "utf8").trim(),
        "",
        `Merge origin/${this.defaultBranch} into your branch with git merge, resolve the conflicts so both sides keep working, run the checks yourself, commit, then write the output file again.`,
      );
    } else if (resynced) {
      parts.push(
        `After origin/${this.defaultBranch} was merged into your branch, the quality gate failed in round ${run.round}. Its report:`,
        "",
        readFileSync(join(roundDir, "resync", "checks.md"), "utf8").trim(),
        "",
        "The merge commit is on your branch. Fix the cause, run the checks yourself, commit, then write the output file again.",
      );
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

  private waitForHuman(run: Run, gate: Exclude<Gate, "issue_writer" | "critic" | "plan">, reasons: string[], data?: Record<string, unknown>): StepResult {
    this.deps.store.recordDecision({
      run_id: run.id,
      gate,
      mode: this.deps.config.gates[gate],
      outcome: "escalate",
      actor: "system",
      comment: reasons.join("; "),
    });
    this.move(run, "needs_human", `waiting at ${gate} gate: ${reasons.join("; ")}`, { ...data, reasons }, undefined, { waiting_gate: gate });
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
    return this.escalate(run, this.troubleReason(role, turn));
  }

  /** Why an agent's turn did not produce a usable output. */
  private troubleReason(role: string, turn: Exclude<TurnResult<VerdictKind>, { status: "ok" }>): string {
    if (turn.status === "invalid") return `${role} output was rejected twice: ${turn.problems.join("; ")}`;
    const { outcome } = turn.agent;
    const detail = outcome.kind === "error" ? `${outcome.subtype}: ${outcome.message}` : outcome.kind;
    return `${role} agent failed (${detail.slice(0, 500)})`;
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
