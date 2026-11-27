import { randomBytes } from "node:crypto";
import { isTerminal, STAGES, type FactoryConfig, type RunState } from "@factory/shared";
import { FactoryEvents, type FactoryEvent } from "../events.js";
import { fetchIssue } from "../github/issues.js";
import type { GithubPort } from "../github/port.js";
import type { DriveOutcome } from "../pipeline/driver.js";
import { listRegistered, type RegistryEntry } from "../registry.js";
import { auditDue, listAudits, type AuditRecord } from "../security/audit.js";
import { auditProject } from "../service/audit.js";
import { openRegisteredProject, type ProjectContext } from "../service/project.js";
import { driveIssue, trustedConfig, type DriveDeps, type Driven, type DriveOptions } from "../service/runs.js";
import type { Project, Run } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { atStartLimit, startLimit, waitingToStart, type StartLimit } from "./start-limit.js";
import { readStopRequest, type StopRequest } from "./stop.js";

/**
 * Works through the queues of the projects it is given: continues runs nobody is working
 * on (a worker died, or a run was stopped), then starts queued issues, within the limits. Every run
 * is driven with `driveIssue`, exactly as `factory run` does, so trust, gates and hard rules apply
 * the same way. `factory work` runs it in the foreground; `factory serve` will run it in the server.
 */

/** Drives one issue's run until it needs someone; `driveIssue` outside tests. */
export type DriveFn = (ctx: ProjectContext, number: number, options: DriveOptions, deps: DriveDeps) => Promise<Driven>;

/** Scans a project's default branch (`auditProject` outside tests); records a failed scan rather than throwing. */
export type AuditFn = (ctx: ProjectContext, signal: AbortSignal) => Promise<AuditRecord>;

export type SchedulerEvent =
  /** Progress of a run the scheduler drives. */
  | { type: "run"; project: string; issue: number; event: FactoryEvent }
  | { type: "started"; project: string; issue: number; run: Run; recovered: boolean }
  | { type: "finished"; project: string; issue: number; run: Run; outcome: DriveOutcome }
  | { type: "failed"; project: string; issue: number; error: string }
  /** Something the scheduler could not use: a project that doesn't open, an issue it couldn't fetch. */
  | { type: "skipped"; project: string; issue?: number; reason: string }
  | { type: "notice"; project: string; issue: number; message: string }
  /** A tick went wrong (the project list or a database could not be read); the next one tries again. */
  | { type: "error"; message: string }
  | { type: "paused"; until: string }
  | { type: "resumed" }
  /** A project's queued issues wait for `github.max_starts_per_day`: said once, not every tick. */
  | { type: "limited"; project: string; started: number; max: number; until?: string }
  /** A project held by its start limit starts queued issues again. */
  | { type: "unlimited"; project: string }
  | { type: "stopping"; now: boolean; interrupted: number }
  /** A scheduled or requested audit of a project's default branch. */
  | { type: "audit_started"; project: string }
  | { type: "audit_finished"; project: string; status: AuditRecord["status"]; findings: number }
  /** git could not give the audit a checkout; tried again after a cooldown. */
  | { type: "audit_failed"; project: string; error: string };

export interface SchedulerStatus {
  running: { project: string; issue: number; runId?: string }[];
  /** Usage limit reached: nothing starts or continues before this time. */
  pausedUntil?: string;
  /** Projects whose queued issues wait for their start limit; `until` is unset when it is 0. */
  limited: { project: string; started: number; max: number; until?: string }[];
  /** `drain` finishes the runs it has and starts none; `now` interrupted them. */
  stopping?: "drain" | "now";
  /** Audits going on, and those asked for that wait for a slot, by project path. */
  audits: { project: string; path: string; state: "running" | "requested" }[];
}

export interface SchedulerOptions {
  /** Lease owner name; `work-<pid>-<random>` by default. */
  owner?: string;
  /** When this worker started: a stop request from before then is old. Defaults to construction time. */
  startedAt?: number;
  /** Runs this worker drives at once, across projects. */
  maxRuns?: number;
  projects?: () => RegistryEntry[];
  open?: (entry: RegistryEntry) => ProjectContext;
  drive?: DriveFn;
  now?: () => number;
  /** The project's config from its default branch. Cached here, since reading it fetches. */
  trustedConfig?: (ctx: ProjectContext) => FactoryConfig;
  /** Refreshes an issue from GitHub before its run starts or continues; closes and unqueues it when it was closed there. */
  fetchIssue?: (ctx: ProjectContext, number: number) => void;
  stopRequest?: () => StopRequest | undefined;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  github?: (project: Project) => GithubPort | undefined;
  audit?: AuditFn;
  /** A project's past audits, for `security.audit_schedule`; `listAudits` by default. */
  audits?: (ctx: ProjectContext) => Pick<AuditRecord, "status" | "started_at">[];
  onEvent?: (event: SchedulerEvent) => void;
  tickMs?: number;
}

export const DEFAULT_MAX_RUNS = 3;
const TICK_MS = 5_000;
const CONFIG_TTL_MS = 5 * 60_000;
// Long enough not to spin on a run that keeps coming back stopped, short enough to retry the same day.
const COOLDOWN_MS = 30 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 30 * 60_000;
const MIN_PAUSE_MS = 60_000;
const WORKING: RunState[] = [...STAGES];

interface Opened {
  entry: RegistryEntry;
  ctx: ProjectContext;
  config?: { value: FactoryConfig; at: number } | { error: string; at: number };
  /** Its past audits, read again when one finishes or the cache runs out. */
  audits?: { value: Pick<AuditRecord, "status" | "started_at">[]; at: number };
}

interface Auditing {
  project: string;
  controller: AbortController;
}

interface InFlight {
  project: Opened;
  issue: number;
  runId?: string;
  stop?: () => void;
}

interface Candidate {
  project: Opened;
  issue: number;
  /** The run to continue; a new start has none. */
  runId?: string;
}

export class Scheduler {
  private readonly owner: string;
  private readonly maxRuns: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly opened = new Map<string, Opened>();
  private readonly unopenable = new Set<string>();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly cooldown = new Map<string, number>();
  /** Projects held by their start limit, by path, with what was last said about it. */
  private readonly limited = new Map<string, { project: string; limit: StartLimit }>();
  /** Audits going on, by project path. */
  private readonly auditing = new Map<string, Auditing>();
  /** Projects whose audit was asked for (`requestAudit`), by path, with their name. */
  private readonly auditRequested = new Map<string, string>();
  private pausedUntil?: number;
  private stopping?: "drain" | "now";
  private wake?: () => void;

  constructor(private readonly options: SchedulerOptions = {}) {
    // The suffix keeps a new worker that reuses a dead one's pid from sharing its leases.
    this.owner = options.owner ?? `work-${process.pid}-${randomBytes(3).toString("hex")}`;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  status(): SchedulerStatus {
    return {
      running: [...this.inFlight.values()].map((f) => ({ project: f.project.ctx.project.name, issue: f.issue, runId: f.runId })),
      pausedUntil: this.pausedUntil === undefined ? undefined : new Date(this.pausedUntil).toISOString(),
      limited: [...this.limited.values()].map(({ project, limit }) => ({ project, started: limit.started, max: limit.max, until: limit.nextStartAt })),
      stopping: this.stopping,
      audits: [
        ...[...this.auditing].map(([path, a]) => ({ project: a.project, path, state: "running" as const })),
        ...[...this.auditRequested].filter(([path]) => !this.auditing.has(path)).map(([path, project]) => ({ project, path, state: "requested" as const })),
      ],
    };
  }

  /**
   * Audit the project at `repoPath` once a slot is free, whatever its schedule: the web app's "Run
   * audit now". False when one is already going on or asked for, or the worker is stopping.
   */
  requestAudit(repoPath: string, name: string): boolean {
    if (this.stopping || this.auditing.has(repoPath) || this.auditRequested.has(repoPath)) return false;
    this.auditRequested.set(repoPath, name);
    this.wake?.();
    return true;
  }

  /** Runs and audits going on: an audit takes a slot like a run. */
  private busy(): number {
    return this.inFlight.size + this.auditing.size;
  }

  /** Stop the audits going on; each records itself as cancelled, so a scheduled one runs again later. */
  private abortAudits(): number {
    this.auditRequested.clear();
    for (const audit of this.auditing.values()) audit.controller.abort();
    return this.auditing.size;
  }

  /** Start nothing more; the runs going on finish. */
  drain(): void {
    if (this.stopping) return;
    this.stopping = "drain";
    // An audit can take hours: draining stops it rather than waiting for it.
    this.abortAudits();
    this.emit({ type: "stopping", now: false, interrupted: 0 });
  }

  /**
   * Interrupt every run this worker drives, the way Ctrl+C does in `factory run`: kill its agents and
   * give its lease back, so it can be continued later. The caller exits afterwards: the drives
   * themselves are left behind, not awaited. Returns how many runs were interrupted.
   */
  stopNow(): number {
    if (this.stopping === "now") return 0;
    this.stopping = "now";
    let interrupted = 0;
    for (const flight of this.inFlight.values()) {
      // driveIssue hands out `stop` before it awaits anything, so every run that holds a lease has
      // one; a flight without it returned before taking the lease.
      if (!flight.stop) continue;
      flight.stop();
      interrupted++;
    }
    interrupted += this.abortAudits();
    this.emit({ type: "stopping", now: true, interrupted });
    return interrupted;
  }

  /** Pick and start runs, without waiting for them. Never throws: a worker that died here would leave its agents running. */
  tick(): void {
    try {
      this.pick();
    } catch (err) {
      this.emit({ type: "error", message: (err as Error).message ?? String(err) });
    }
  }

  private pick(): void {
    this.checkStopRequest();
    if (this.stopping) return;
    const now = this.now();
    if (this.pausedUntil !== undefined) {
      if (now < this.pausedUntil) return;
      this.pausedUntil = undefined;
      this.emit({ type: "resumed" });
    }
    const projects = this.openProjects();
    this.reviewStartLimits(projects, now);
    if (this.busy() >= this.maxRuns) return;

    for (const candidate of [...this.recoveries(projects, now), ...this.newStarts(projects, now)]) {
      if (this.busy() >= this.maxRuns || this.pausedUntil !== undefined) return;
      if (this.inFlight.has(keyOf(candidate.project, candidate.issue))) continue;
      const config = this.config(candidate.project, now);
      if (!config) continue;
      if (this.runningIn(candidate.project, now) >= config.concurrency.max_runs) continue;
      if (!candidate.runId && this.heldByStartLimit(candidate.project, config, now)) continue;
      if (!this.stillOpen(candidate, now)) continue;
      this.launch(candidate);
    }
    // After the runs, which come first for the slots.
    this.pickAudits(projects, now);
  }

  private pickAudits(projects: Opened[], now: number): void {
    for (const project of projects) {
      if (this.busy() >= this.maxRuns || this.pausedUntil !== undefined) return;
      const path = project.entry.path;
      if (this.auditing.has(path) || this.cooling(project, "audit", now)) continue;
      const config = this.config(project, now);
      if (!config) continue;
      const schedule = config.security.audit_schedule;
      if (!this.auditRequested.has(path) && (schedule === "off" || !auditDue(this.pastAudits(project, now), schedule, now))) continue;
      if (this.runningIn(project, now) >= config.concurrency.max_runs) continue;
      this.launchAudit(project);
    }
  }

  private pastAudits(project: Opened, now: number): Pick<AuditRecord, "status" | "started_at">[] {
    if (!project.audits || now - project.audits.at >= CONFIG_TTL_MS) {
      project.audits = { value: (this.options.audits ?? ((ctx: ProjectContext) => listAudits(ctx.project)))(project.ctx), at: now };
    }
    return project.audits.value;
  }

  private launchAudit(project: Opened): void {
    const path = project.entry.path;
    const name = project.ctx.project.name;
    const controller = new AbortController();
    this.auditing.set(path, { project: name, controller });
    this.auditRequested.delete(path);
    this.emit({ type: "audit_started", project: name });
    const audit: AuditFn = this.options.audit ?? ((ctx, signal) => auditProject(ctx, { run: this.options.run, signal }));
    let auditing: Promise<AuditRecord>;
    try {
      auditing = audit(project.ctx, controller.signal);
    } catch (err) {
      auditing = Promise.reject(err);
    }
    void auditing
      .then((record) => this.emit({ type: "audit_finished", project: name, status: record.status, findings: record.findings.length }))
      .catch((err: unknown) => {
        this.emit({ type: "audit_failed", project: name, error: (err as Error).message ?? String(err) });
        this.coolDown(project, "audit", this.now());
      })
      .finally(() => {
        this.auditing.delete(path);
        project.audits = undefined;
        this.wake?.();
      });
  }

  /** Tick until stopped. Resolves `drained` once the runs it had are finished, or `interrupted` after `stopNow`. */
  run(signal?: AbortSignal): Promise<"drained" | "interrupted"> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let done = false;
      const loop = () => {
        if (done) return;
        if (signal?.aborted) this.stopNow();
        this.tick();
        // Interrupted drives are left behind, but aborted audits are waited for: they remove their worktree.
        if ((this.stopping === "now" && this.auditing.size === 0) || (this.stopping === "drain" && this.busy() === 0)) {
          done = true;
          this.wake = undefined;
          return resolve(this.stopping === "now" ? "interrupted" : "drained");
        }
        timer = setTimeout(loop, this.options.tickMs ?? TICK_MS);
      };
      // A run that finishes frees a slot: look again straight away rather than at the next tick.
      this.wake = () => {
        if (done) return;
        clearTimeout(timer);
        timer = setTimeout(loop, 0);
      };
      signal?.addEventListener("abort", () => this.wake?.(), { once: true });
      loop();
    });
  }

  private checkStopRequest(): void {
    if (this.stopping === "now") return;
    const request = (this.options.stopRequest ?? readStopRequest)();
    if (!request || request.at <= this.startedAt) return;
    if (request.now) this.stopNow();
    else this.drain();
  }

  private openProjects(): Opened[] {
    const result: Opened[] = [];
    for (const entry of (this.options.projects ?? listRegistered)()) {
      const known = this.opened.get(entry.path);
      if (known) {
        result.push(known);
        continue;
      }
      try {
        const opened = { entry, ctx: (this.options.open ?? openRegisteredProject)(entry) };
        this.opened.set(entry.path, opened);
        this.unopenable.delete(entry.path);
        result.push(opened);
      } catch (err) {
        // Reported once, tried again every tick: it may be set up later.
        if (!this.unopenable.has(entry.path)) this.emit({ type: "skipped", project: entry.name, reason: (err as Error).message });
        this.unopenable.add(entry.path);
      }
    }
    return result;
  }

  /** Working runs of a queued issue that nobody holds, oldest first. */
  private recoveries(projects: Opened[], now: number): Candidate[] {
    const nowIso = new Date(now).toISOString();
    const found: { candidate: Candidate; updated: string }[] = [];
    for (const project of projects) {
      const { store, project: row } = project.ctx;
      for (const run of store.listRuns({ project_id: row.id, states: WORKING })) {
        if (run.issue_number === null || this.cooling(project, run.issue_number, now)) continue;
        if (run.lease_owner !== null && run.lease_expires_at !== null && run.lease_expires_at >= nowIso) continue;
        if (!store.getIssue(row.id, run.issue_number)?.queued_at) continue;
        // Hard rules were lifted for a person watching that run; carrying on without them would be unattended.
        if (run.unsafe) continue;
        found.push({ candidate: { project, issue: run.issue_number, runId: run.id }, updated: run.updated_at });
      }
    }
    return found.sort((a, b) => compare(a.updated, b.updated)).map((f) => f.candidate);
  }

  /**
   * Queued issues with no run since they were queued, in queue order. A run that failed, was
   * rejected or cancelled leaves its issue queued: starting it again would repeat it forever.
   */
  private newStarts(projects: Opened[], now: number): Candidate[] {
    const found: { candidate: Candidate; queuedAt: string; seq: number }[] = [];
    for (const project of projects) {
      const { store, project: row } = project.ctx;
      const runs = store.listRuns({ project_id: row.id });
      for (const issue of store.listIssues({ project_id: row.id, state: "open", queued: true })) {
        if (!issue.queued_at || this.cooling(project, issue.number, now)) continue;
        const own = runs.filter((r) => r.issue_number === issue.number);
        // A run still going or waiting belongs to recovery or to a human, whenever it was created.
        if (own.some((r) => r.created_at >= issue.queued_at! || !isTerminal(r.state))) continue;
        found.push({ candidate: { project, issue: issue.number }, queuedAt: issue.queued_at, seq: issue.queue_seq ?? 0 });
      }
    }
    return found.sort((a, b) => compare(a.queuedAt, b.queuedAt) || a.seq - b.seq).map((f) => f.candidate);
  }

  /**
   * Looks again at every project held by its start limit, even on a tick that starts nothing (the
   * worker is full), so what it says stays true: a project that has gone, or has nothing left waiting
   * to start, is no longer held, and one whose window has moved on is let go.
   */
  private reviewStartLimits(projects: Opened[], now: number): void {
    for (const [key, held] of this.limited) {
      const project = projects.find((p) => p.entry.path === key);
      const config = project && this.config(project, now);
      if (!project || !config || waitingToStart(project.ctx.store, project.ctx.project.id).length === 0) {
        this.limited.delete(key);
        continue;
      }
      if (!atStartLimit(startLimit(project.ctx.store, project.ctx.project.id, config.github.max_starts_per_day, now))) {
        this.limited.delete(key);
        this.emit({ type: "unlimited", project: held.project });
      }
    }
  }

  /**
   * Whether the project's start limit holds its new runs back. Said once when it starts holding (and
   * again if the time it lifts changes), and once when it lets them go, so the queue never just
   * stops without a word.
   */
  private heldByStartLimit(project: Opened, config: FactoryConfig, now: number): boolean {
    const { store, project: row } = project.ctx;
    const limit = startLimit(store, row.id, config.github.max_starts_per_day, now);
    const key = project.entry.path;
    const held = this.limited.get(key);
    if (!atStartLimit(limit)) {
      if (held) {
        this.limited.delete(key);
        this.emit({ type: "unlimited", project: row.name });
      }
      return false;
    }
    if (!held || held.limit.nextStartAt !== limit.nextStartAt) {
      this.emit({ type: "limited", project: row.name, started: limit.started, max: limit.max, until: limit.nextStartAt });
    }
    this.limited.set(key, { project: row.name, limit });
    return true;
  }

  private stillOpen(candidate: Candidate, now: number): boolean {
    const { store, project: row } = candidate.project.ctx;
    // The local copy may be stale: work on an issue closed on GitHub since the last sync must stop.
    try {
      (this.options.fetchIssue ?? ((ctx, n) => fetchIssue(ctx.store, ctx.project, n, this.options.run)))(candidate.project.ctx, candidate.issue);
    } catch (err) {
      this.coolDown(candidate.project, candidate.issue, now);
      this.emit({ type: "skipped", project: row.name, issue: candidate.issue, reason: `could not fetch it: ${(err as Error).message.split("\n")[0]}` });
      return false;
    }
    const issue = store.getIssue(row.id, candidate.issue);
    return issue?.state === "open" && issue.queued_at !== null;
  }

  /** Runs in the project this worker drives, plus those other processes hold a live lease on. */
  private runningIn(project: Opened, now: number): number {
    const nowIso = new Date(now).toISOString();
    const ours = [...this.inFlight.values()].filter((f) => f.project === project).length + (this.auditing.has(project.entry.path) ? 1 : 0);
    const others = project.ctx.store
      .listRuns({ project_id: project.ctx.project.id, states: WORKING })
      .filter((r) => r.lease_owner !== null && r.lease_owner !== this.owner && r.lease_expires_at !== null && r.lease_expires_at >= nowIso);
    return ours + others.length;
  }

  /**
   * Read a project's config again on the next tick rather than after the cache runs out: its
   * settings were just changed on the default branch.
   */
  forgetConfig(repoPath: string): void {
    const project = this.opened.get(repoPath);
    if (project) project.config = undefined;
    this.wake?.();
  }

  private config(project: Opened, now: number): FactoryConfig | undefined {
    const cached = project.config;
    if (!cached || now - cached.at >= CONFIG_TTL_MS) {
      try {
        const read = this.options.trustedConfig ?? ((ctx: ProjectContext) => trustedConfig(ctx.project, ctx.config, this.options.run));
        project.config = { value: read(project.ctx), at: now };
      } catch (err) {
        const reason = `could not read its config from the default branch: ${(err as Error).message.split("\n")[0]}`;
        if (!cached || !("error" in cached)) this.emit({ type: "skipped", project: project.ctx.project.name, reason });
        project.config = { error: reason, at: now };
      }
    }
    return "value" in project.config! ? project.config.value : undefined;
  }

  private launch(candidate: Candidate): void {
    const { project, issue, runId } = candidate;
    const recovered = runId !== undefined;
    const name = project.ctx.project.name;
    const key = keyOf(project, issue);
    const flight: InFlight = { project, issue };
    this.inFlight.set(key, flight);
    const events = new FactoryEvents();
    events.on((event) => this.emit({ type: "run", project: name, issue, event }));
    const drive = this.options.drive ?? driveIssue;
    // Never re-triage: only a person (or the issue's author, #21) can say the questions were answered.
    const options: DriveOptions = { runId, retriage: false };
    const deps: DriveDeps = {
      owner: this.owner,
      run: this.options.run,
      env: this.options.env,
      github: this.options.github?.(project.ctx.project),
      events,
      onNotice: (notice) => {
        if (notice.type === "started") {
          flight.runId = notice.run.id;
          flight.stop = notice.stop;
          this.emit({ type: "started", project: name, issue, run: notice.run, recovered });
        } else if (notice.type === "no_checks") {
          this.emit({ type: "notice", project: name, issue, message: "no checks are configured on the default branch; the quality gate only scans for secrets" });
        }
      },
    };
    let driving: Promise<Driven>;
    try {
      driving = drive(project.ctx, issue, options, deps);
    } catch (err) {
      driving = Promise.reject(err);
    }
    void driving
      .then(({ outcome, run }) => {
        this.emit({ type: "finished", project: name, issue, run, outcome });
        if (outcome.kind === "rate_limited") this.pause(outcome.resetsAt);
        if (outcome.kind === "stopped") this.coolDown(project, issue, this.now());
      })
      .catch((err: unknown) => {
        this.emit({ type: "failed", project: name, issue, error: (err as Error).message ?? String(err) });
        this.coolDown(project, issue, this.now());
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.wake?.();
      });
  }

  /** One account: a usage limit stops every start and continuation until it resets. */
  private pause(resetsAt: string | undefined): void {
    const now = this.now();
    const reset = resetsAt ? Date.parse(resetsAt) : NaN;
    const until = Number.isNaN(reset) || reset <= now ? now + RATE_LIMIT_BACKOFF_MS : Math.max(reset, now + MIN_PAUSE_MS);
    if (this.pausedUntil !== undefined && this.pausedUntil >= until) return;
    this.pausedUntil = until;
    this.emit({ type: "paused", until: new Date(until).toISOString() });
  }

  private coolDown(project: Opened, issue: number | "audit", now: number): void {
    this.cooldown.set(keyOf(project, issue), now + COOLDOWN_MS);
  }

  private cooling(project: Opened, issue: number | "audit", now: number): boolean {
    const until = this.cooldown.get(keyOf(project, issue));
    return until !== undefined && now < until;
  }

  private emit(event: SchedulerEvent): void {
    this.options.onEvent?.(event);
  }
}

function keyOf(project: Opened, issue: number | "audit"): string {
  return `${project.entry.path}#${issue}`;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
