import { existsSync, readFileSync } from "node:fs";
import {
  approveDraft,
  discardPendingDraft,
  draftIssue,
  ensureDraftsIgnored,
  FactoryEvents,
  GithubError,
  pendingDrafts,
  saveDraft,
  ServiceError,
  type CommandRunner,
  type DraftEdit,
  type DraftEntry,
  type DraftIssueEdit,
  type FactoryEvent,
  type IssueDraft,
  type IssueWriterPort,
  type Project,
  type ProjectContext,
  type PublishedDraft,
} from "@factory/core";
import type { FastifyInstance } from "fastify";
import { BadRequest, Conflict } from "./errors.js";
import type { EventHub } from "./hub.js";
import { NotFoundError, type ProjectSet } from "./projects.js";

/** An issue created from a draft, with its GitHub page once it is synced. */
export interface CreatedIssue {
  number: number;
  title: string;
  url: string | null;
}

export interface PublishedView {
  issue: CreatedIssue;
  subIssues: CreatedIssue[];
  buildable: number[];
  queued: number[];
}

/** How a draft started from the web ended: created (the gate let it through), waiting for a person, or failed. */
export type DraftResult = { kind: "published"; published: PublishedView } | { kind: "waiting"; reasons: string[] } | { kind: "failed"; error: string };

/** An issue writer this server started, or a draft it created: what the New issue screen follows. */
export interface DraftJobView {
  running: boolean;
  /** The agent's progress so far, the latest last. */
  events: FactoryEvent[];
  result?: DraftResult;
}

/** A pending draft as the Inbox and the editor show it. No local path in it. */
export interface DraftView {
  project: string;
  projectName: string;
  id: string;
  idea: string;
  createdAt: string;
  /** The issue writer is still writing it: it can't be saved, created or discarded yet. */
  running: boolean;
  draft: IssueDraft | null;
  problems: string[];
  refusal: string | null;
  created: number[];
}

export interface DraftDetail {
  project: string;
  projectName: string;
  id: string;
  /** Null once it is created or discarded. */
  pending: (DraftView & { text: string | null }) | null;
  job: DraftJobView | null;
}

/** Enough progress to follow the agent; a long session would otherwise grow without end. */
const MAX_EVENTS = 200;
const SHOWN_EVENTS = new Set<FactoryEvent["type"]>(["agent:start", "agent:activity", "agent:end", "info"]);

interface Job extends DraftJobView {
  controller?: AbortController;
}

export interface DraftJobDeps {
  hub: EventHub;
  run?: CommandRunner;
  /** For the agent: tests point FACTORY_CLAUDE_BIN at the fake. */
  env?: NodeJS.ProcessEnv;
  issueWriter?: (project: Project) => IssueWriterPort | undefined;
  log: (line: string) => void;
}

function message(err: unknown, log: (line: string) => void): string {
  if (err instanceof ServiceError || err instanceof GithubError) return err.message;
  log(`error: ${(err as Error).stack ?? String(err)}`);
  return "Something went wrong; the terminal running `factory serve` has the details.";
}

/**
 * The issue writers the web started, per project and draft, with their progress and how they
 * ended. In memory only: after a restart a draft is still listed, just without its progress.
 */
export class DraftJobs {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly deps: DraftJobDeps) {}

  get(key: string, id: string): DraftJobView | undefined {
    const job = this.jobs.get(`${key}/${id}`);
    return job && { running: job.running, events: job.events, ...(job.result ? { result: job.result } : {}) };
  }

  isRunning(key: string, id: string): boolean {
    return this.jobs.get(`${key}/${id}`)?.running === true;
  }

  /**
   * Starts the issue writer and resolves with the draft's id once its folder exists, long before
   * the agent is done. A draft the gate lets through is created right away, as `factory new` does.
   */
  async start(key: string, ctx: ProjectContext, idea: string, queue: boolean): Promise<string> {
    const { hub } = this.deps;
    const controller = new AbortController();
    const events = new FactoryEvents();
    let id: string | undefined;
    let started!: (id: string) => void;
    const startedOnce = new Promise<string>((resolve) => (started = resolve));
    const job: Job = { running: true, events: [], controller };
    events.on((event) => {
      if (!id || !SHOWN_EVENTS.has(event.type)) return;
      job.events.push(event);
      if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
      hub.publish({ type: "draft", project: key, draftId: id, event });
    });

    const work = draftIssue(ctx, idea, {
      run: this.deps.run,
      env: this.deps.env,
      events,
      signal: controller.signal,
      onStart: (draftId) => {
        id = draftId;
        this.jobs.set(`${key}/${draftId}`, job);
        started(draftId);
      },
    });
    // Settled on every path, so a failure after the response never goes unhandled.
    void work
      .then(
        (outcome): DraftResult => (outcome.kind === "ready" ? this.publish(key, ctx, outcome.id, queue) : { kind: "waiting", reasons: outcome.reasons }),
        // Before the folder exists the request itself fails with the error, and there is no job.
        (err: unknown): DraftResult => ({ kind: "failed", error: id ? message(err, this.deps.log) : "" }),
      )
      .then((result) => {
        if (!id) return;
        job.running = false;
        job.controller = undefined;
        job.result = result;
        hub.publish({ type: "draft:done", project: key, draftId: id, result });
        hub.publish({ type: "changed", project: key });
      });
    // A failure before the folder exists (the default branch can't be read) is the request's answer.
    const ended = work.then(() => {
      if (!id) throw new Error("the issue writer ended without starting a draft");
      return id;
    });
    return Promise.race([startedOnce, ended]);
  }

  /**
   * Creates a draft's issues on GitHub with approveDraft, as `factory new --approve` does, and
   * remembers it for the screen that follows the draft. Throws approveDraft's errors.
   */
  create(key: string, ctx: ProjectContext, id: string, queue: boolean): PublishedView {
    const published = publishedView(ctx, approveDraft(ctx, id, { run: this.deps.run, github: this.deps.issueWriter?.(ctx.project), queue }));
    const result: DraftResult = { kind: "published", published };
    const job = this.jobs.get(`${key}/${id}`);
    if (job) job.result = result;
    else this.jobs.set(`${key}/${id}`, { running: false, events: [], result });
    return published;
  }

  private publish(key: string, ctx: ProjectContext, id: string, queue: boolean): DraftResult {
    try {
      return { kind: "published", published: this.create(key, ctx, id, queue) };
    } catch (err) {
      return { kind: "failed", error: message(err, this.deps.log) };
    }
  }

  forget(key: string, id: string): void {
    this.jobs.delete(`${key}/${id}`);
  }

  /** Stops one issue writer; its draft stays for a discard. */
  stop(key: string, id: string): boolean {
    const job = this.jobs.get(`${key}/${id}`);
    if (!job?.running) return false;
    job.controller?.abort();
    return true;
  }

  /** On close: an agent nobody can follow any more is stopped. */
  stopAll(): void {
    for (const job of this.jobs.values()) job.controller?.abort();
  }
}

function publishedView(ctx: ProjectContext, published: PublishedDraft): PublishedView {
  const created = ({ number, title }: { number: number; title: string }): CreatedIssue => ({
    number,
    title,
    url: ctx.store.getIssue(ctx.project.id, number)?.url ?? null,
  });
  return { issue: created(published.issue), subIssues: published.subIssues.map(created), buildable: published.buildable, queued: published.queued };
}

function viewOf(key: string, ctx: ProjectContext, entry: DraftEntry, running: boolean): DraftView {
  return {
    project: key,
    projectName: ctx.project.name,
    id: entry.id,
    idea: entry.idea,
    createdAt: entry.createdAt.toISOString(),
    running,
    // While the agent writes, a missing or half-written file is no problem yet.
    draft: running ? null : (entry.draft ?? null),
    problems: running ? [] : entry.problems,
    refusal: entry.refusal ?? null,
    created: entry.created,
  };
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequest(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function issueEdit(value: unknown, name: string): DraftIssueEdit {
  const fields = record(value, name);
  for (const field of ["title", "risk", "body"]) {
    if (typeof fields[field] !== "string") throw new BadRequest(`${name}.${field} must be text.`);
  }
  if (typeof fields.ui !== "boolean") throw new BadRequest(`${name}.ui must be true or false.`);
  const dependsOn = fields.dependsOn ?? [];
  if (!Array.isArray(dependsOn) || !dependsOn.every((n) => Number.isInteger(n))) throw new BadRequest(`${name}.dependsOn must be a list of numbers.`);
  return { title: fields.title as string, ui: fields.ui, risk: fields.risk as string, body: fields.body as string, dependsOn: dependsOn as number[] };
}

/** The editor's fields, checked for their types only: what they say is parseDraft's to judge. */
export function draftEdit(body: unknown): DraftEdit {
  const fields = record(body, "The draft");
  if (!Array.isArray(fields.subIssues)) throw new BadRequest("subIssues must be a list.");
  return { issue: issueEdit(fields.issue, "issue"), subIssues: fields.subIssues.map((s, i) => issueEdit(s, `sub-issue ${i + 1}`)) };
}

function flag(body: unknown, field: string): boolean {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BadRequest(`${field} must be true or false.`);
  return value;
}

export interface DraftRouteOptions {
  projects: ProjectSet;
  jobs: DraftJobs;
  run?: CommandRunner;
  changed: (project: string) => void;
}

/**
 * The New issue screen's API: `factory new` in the browser, with its rules. Drafts are named by
 * their exact id, looked up among the pending ones, so a ref is never a prefix or a path.
 */
export function draftRoutes(app: FastifyInstance, options: DraftRouteOptions): void {
  const { projects, jobs, run, changed } = options;

  const pendingOf = (key: string, ctx: ProjectContext): DraftView[] =>
    pendingDrafts(ctx, run).map((entry) => viewOf(key, ctx, entry, jobs.isRunning(key, entry.id)));

  /** The pending draft, ready for a change: not one the agent is still writing. */
  const idle = (key: string, ctx: ProjectContext, id: string): DraftEntry => {
    const entry = pendingDrafts(ctx, run).find((d) => d.id === id);
    if (!entry) throw new NotFoundError(`No pending draft ${id} in ${ctx.project.name}.`);
    if (jobs.isRunning(key, id)) throw new Conflict(`The issue writer is still writing ${id}. Wait for it, or stop it first.`);
    return entry;
  };

  app.get<{ Querystring: { project?: string } }>("/api/drafts", async (req) => {
    const opened = req.query.project ? [{ key: req.query.project, ctx: projects.byKey(req.query.project) }] : projects.openAll();
    return opened.flatMap(({ key, ctx }) => pendingOf(key, ctx));
  });

  type DraftParams = { Params: { key: string; id: string }; Body: unknown };
  app.get<DraftParams>("/api/projects/:key/drafts/:id", async (req): Promise<DraftDetail> => {
    const { key, id } = req.params;
    const ctx = projects.byKey(key);
    const entry = pendingDrafts(ctx, run).find((d) => d.id === id);
    const job = jobs.get(key, id);
    if (!entry && !job) throw new NotFoundError(`No draft ${id} in ${ctx.project.name}.`);
    const pending = entry && {
      ...viewOf(key, ctx, entry, jobs.isRunning(key, id)),
      text: !jobs.isRunning(key, id) && existsSync(entry.file) ? readFileSync(entry.file, "utf8") : null,
    };
    return { project: key, projectName: ctx.project.name, id, pending: pending ?? null, job: job ?? null };
  });

  app.post<{ Params: { key: string }; Body: unknown }>("/api/projects/:key/drafts", async (req) => {
    const key = req.params.key;
    const ctx = projects.byKey(key);
    const idea = (req.body as Record<string, unknown> | null | undefined)?.idea;
    if (typeof idea !== "string" || !idea.trim()) throw new BadRequest("Say what the issue is about (idea).");
    const queue = flag(req.body, "queue");
    const ignored = ensureDraftsIgnored(ctx);
    const id = await jobs.start(key, ctx, idea, queue);
    changed(key);
    return { id, ignored };
  });

  app.post<DraftParams>("/api/projects/:key/drafts/:id/save", async (req) => {
    const { key, id } = req.params;
    const ctx = projects.byKey(key);
    idle(key, ctx, id);
    const edit = draftEdit(req.body);
    const saved = saveDraft(ctx, id, edit, run);
    changed(key);
    return viewOf(key, ctx, saved, false);
  });

  app.post<DraftParams>("/api/projects/:key/drafts/:id/publish", async (req) => {
    const { key, id } = req.params;
    const ctx = projects.byKey(key);
    idle(key, ctx, id);
    const queue = flag(req.body, "queue");
    const published = jobs.create(key, ctx, id, queue);
    changed(key);
    return published;
  });

  app.post<DraftParams>("/api/projects/:key/drafts/:id/discard", async (req) => {
    const { key, id } = req.params;
    const ctx = projects.byKey(key);
    idle(key, ctx, id);
    const entry = discardPendingDraft(ctx, id, run);
    jobs.forget(key, id);
    changed(key);
    return { id: entry.id, created: entry.created };
  });

  app.post<DraftParams>("/api/projects/:key/drafts/:id/stop", async (req) => {
    const { key, id } = req.params;
    projects.byKey(key);
    if (!jobs.stop(key, id)) throw new Conflict(`The issue writer is not writing ${id}.`);
    return { id, stopping: true };
  });
}
