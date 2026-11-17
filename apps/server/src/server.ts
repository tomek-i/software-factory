import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import {
  approveRun,
  cancelRun,
  continuation,
  dismissAlert,
  ensureQueued,
  GithubError,
  reconcileAndSweep,
  redactPaths,
  rejectRun,
  reportLines,
  resumeRun,
  resumeTargets,
  runCost,
  runFile,
  runChecks,
  runOverview,
  sendBackTargets,
  ServiceError,
  syncIssues,
  waitingOn,
  type CodeScanningAlert,
  type CommandRunner,
  type GithubPort,
  type IssueWriterPort,
  type OverviewSection,
  type Project,
  type ProjectContext,
  type Run,
  type SchedulerStatus,
  type WaitingFailure,
} from "@factory/core";
import { isTerminal, isTrustedIssue } from "@factory/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { DraftJobs, draftRoutes } from "./drafts.js";
import { BadRequest, Conflict } from "./errors.js";
import type { EventHub } from "./hub.js";
import { NotFoundError, type ProjectSet } from "./projects.js";
import { TooManyRequests, type RateLimit } from "./rate-limit.js";
import { hostAllowed, originAllowed, TOKEN_HEADER, tokenMatches } from "./security.js";

export interface ServerOptions {
  projects: ProjectSet;
  hub: EventHub;
  /** The session token: the link `factory serve` prints carries it, and the page sends it with every API call. */
  token: string;
  /** The port the browser uses, for the Host and Origin checks. Once listening, the real one is used. */
  port: number;
  scheduler?: { status(): SchedulerStatus };
  run?: CommandRunner;
  github?: (project: Project) => GithubPort | undefined;
  /** Creates the New issue screen's issues; without it, `gh` as `factory new` uses. */
  issueWriter?: (project: Project) => IssueWriterPort | undefined;
  /** The environment agents get, as the scheduler's (tests point FACTORY_CLAUDE_BIN at the fake). */
  env?: NodeJS.ProcessEnv;
  /** The built web app; none serves the API only. */
  webRoot?: string;
  /** Where unexpected errors go: the terminal, never the browser. */
  log?: (line: string) => void;
  heartbeatMs?: number;
  /** Per draft route; tests lower it. */
  draftLimit?: RateLimit;
}

export type RunView = "active" | "waiting" | "all";

/** A run as the Runs and Inbox screens show it. */
export interface RunRow {
  project: string;
  projectName: string;
  id: string;
  issue: number | null;
  title: string;
  state: Run["state"];
  waitingGate: Run["waiting_gate"];
  build: number;
  review: number;
  /** Times the merge stage went back to the builder because the default branch conflicted or broke the gate. */
  resyncs: number;
  cost: number;
  /** A worker holds its lease: something is driving it right now. */
  held: boolean;
  updatedAt: string;
  /** Why it is where it is: the reason of its last move. */
  reason?: string;
  /**
   * Where a run parked for a human can be sent. At a gate only the working stages before it:
   * approving, rejecting and cancelling have their own actions.
   */
  resumeTargets: Run["state"][];
  /** The loop cap that stopped it, e.g. "review round cap reached (3)": resumed without fresh loops, it stops again at once. */
  capReached?: string;
  /** What it waits on that the builder could fix, with the details known. */
  failure?: WaitingFailure;
  /** Its issue was closed on GitHub while its PR is open; cancelling closes the PR too. */
  issueClosed?: { pr: number };
}

/** The required checks that failed on a run's PR, for the page that lets a human act on them. */
export interface RunChecksView {
  pr: number;
  failed: { name: string; link?: string; alerts: CodeScanningAlert[] }[];
  otherAlerts: CodeScanningAlert[];
}

/** One run in full, for its detail view: no absolute local path in it. */
export interface RunDetail {
  run: RunRow;
  /** The run's issue, with its GitHub link when it is synced. */
  issue: { number: number; title: string; url: string | null } | null;
  /** Whether the run folder exists yet; without it there are no files or sections. */
  hasRunDir: boolean;
  /** Every file in the run folder, sorted, `/`-separated. */
  files: string[];
  sections: OverviewSection[];
}

const WAITING: Run["state"][] = ["needs_human", "needs_info"];
// Routes anyone may fetch: the app's page and its static files, which hold nothing of the user's.
// Decided on the route Fastify matched, never on the raw URL, which can spell a path many ways.
const PUBLIC_ROUTES = new Set(["/", "/*"]);
const ALL_LIMIT = 200;

function issueNumber(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequest(`"${value}" is not an issue number.`);
  return n;
}

function text(body: unknown, field: string): string | undefined {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequest(`${field} must be text.`);
  return value;
}

/** The run, when it belongs to this project. */
function runOf(ctx: ProjectContext, id: string): Run {
  const run = ctx.store.getRun(id);
  if (!run || run.project_id !== ctx.project.id) throw new NotFoundError(`No run ${id} in ${ctx.project.name}.`);
  return run;
}

/**
 * The page says which state and gate it showed. Runs other processes drive change without the page
 * hearing of it (#133), and approving "the gate it waits at now" could approve a merge the person
 * thought was a triage.
 */
function expectShown(run: Run, body: unknown): void {
  const state = text(body, "state");
  const gate = text(body, "gate");
  if (state === undefined) throw new BadRequest("Say which state the run was in (state).");
  if (run.state !== state || (run.waiting_gate ?? "") !== (gate ?? "")) {
    const now = run.waiting_gate ? `${run.state} at the ${run.waiting_gate} gate` : run.state;
    throw new Conflict(`Run ${run.id} has moved on: it is ${now} now. Look again before deciding.`);
  }
}

function flag(body: unknown, field: string): boolean {
  const value = (body as Record<string, unknown> | null | undefined)?.[field];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new BadRequest(`${field} must be true or false.`);
  return value;
}

function rowOf(key: string, ctx: ProjectContext, run: Run, now: string): RunRow {
  const events = ctx.store.listEvents(run.id);
  const waiting = waitingOn(ctx.store, ctx.project, run);
  const redact = redactorOf(ctx, run);
  return {
    project: key,
    projectName: ctx.project.name,
    id: run.id,
    issue: run.issue_number,
    title: run.title,
    state: run.state,
    waitingGate: run.waiting_gate,
    build: run.build_iterations + 1,
    review: run.review_rounds + 1,
    resyncs: run.resync_rounds,
    cost: runCost(ctx.store, run.id),
    held: run.lease_expires_at !== null && run.lease_expires_at > now,
    updatedAt: run.updated_at,
    reason: events.at(-1)?.reason,
    resumeTargets: run.state !== "needs_human" ? [] : run.waiting_gate ? sendBackTargets(run) : resumeTargets(run),
    ...(waiting.capReached ? { capReached: waiting.capReached } : {}),
    ...(waiting.failure ? { failure: redactFailure(waiting.failure, redact) } : {}),
    ...(waiting.issueClosed ? { issueClosed: waiting.issueClosed } : {}),
  };
}

function redactFailure(failure: WaitingFailure, redact: (text: string) => string): WaitingFailure {
  return {
    ...failure,
    items: failure.items.map((item) => ({
      ...item,
      name: redact(item.name),
      ...(item.summary === undefined ? {} : { summary: redact(item.summary) }),
      ...(item.file === undefined ? {} : { file: redact(item.file) }),
    })),
  };
}

/**
 * Run files hold agent output, which can quote local paths: shown relative to the worktree or the
 * repository, the home folder as `~`, as `factory` does in what it publishes.
 */
function redactorOf(ctx: ProjectContext, run: Run): (text: string) => string {
  const roots = [ctx.project.repo_path, ...(run.worktree_path ? [run.worktree_path] : [])];
  return (text) => redactPaths(text, { home: homedir(), roots });
}

function redactSection(section: OverviewSection, redact: (text: string) => string): OverviewSection {
  if (section.kind === "unparsed") return { ...section, problem: redact(section.problem) };
  if (section.kind === "capture") return { ...section, summary: section.summary.map(redact) };
  if (section.kind === "acceptance") {
    return {
      ...section,
      criteria: section.criteria.map((c) => ({ ...c, text: redact(c.text), ...(c.evidence === undefined ? {} : { evidence: redact(c.evidence) }) })),
    };
  }
  return {
    ...section,
    value: redact(section.value),
    summary: section.summary.map(redact),
    blocking: section.blocking.map((f) => ({
      ...f,
      claim: redact(f.claim),
      evidence: redact(f.evidence),
      ...(f.file === undefined ? {} : { file: redact(f.file) }),
    })),
  };
}

function inView(run: Run, view: RunView): boolean {
  if (view === "waiting") return WAITING.includes(run.state);
  if (view === "active") return !isTerminal(run.state);
  return true;
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // The first page load carries the token in its URL.
  "Referrer-Policy": "no-referrer",
  // Approve and cancel buttons must not be clickable through another site's frame.
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function createServer(options: ServerOptions): FastifyInstance {
  const { projects, hub, token } = options;
  const log = options.log ?? ((line) => console.error(line));
  const app = Fastify({ logger: false });
  /** Each open event stream, with what ends it. */
  const streams = new Map<ServerResponse, () => void>();

  const port = () => {
    const address = app.server.address();
    return address && typeof address === "object" ? address.port : options.port;
  };
  const changed = (project?: string) => hub.publish({ type: "changed", project });
  const drafts = new DraftJobs({ hub, run: options.run, env: options.env, issueWriter: options.issueWriter, log });

  app.addHook("onRequest", async (req, reply) => {
    // Only the origin form (`GET /path`): an absolute URL in the request line is a proxy's business.
    if (!req.raw.url?.startsWith("/")) return reply.code(400).type("text/plain").send("Bad request.");
    if (!hostAllowed(req.headers.host, port())) return reply.code(403).type("text/plain").send("Forbidden host.");
    if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req.headers.origin, port())) {
      return reply.code(403).send({ error: "Forbidden origin." });
    }
    const route = req.routeOptions.url;
    if (route !== undefined && !PUBLIC_ROUTES.has(route) && !tokenMatches(req.headers[TOKEN_HEADER], token)) {
      return reply.code(401).send({ error: "Open the link `factory serve` printed." });
    }
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof Conflict) return reply.code(409).send({ error: err.message });
    if (err instanceof TooManyRequests) return reply.code(429).header("Retry-After", String(err.retryAfter)).send({ error: err.message });
    if (err instanceof ServiceError || err instanceof BadRequest) return reply.code(400).send({ error: err.message });
    if (err instanceof GithubError) return reply.code(502).send({ error: `GitHub: ${err.message}` });
    // Fastify's own (a malformed JSON body, say) carry a 4xx status and a message meant for the client.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    log(`error: ${err.stack ?? err.message}`);
    return reply.code(500).send({ error: "Something went wrong; the terminal running `factory serve` has the details." });
  });

  app.get("/api/projects", async () => projects.info());

  app.get<{ Params: { key: string } }>("/api/projects/:key/issues", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const { store, project, config } = ctx;
    const runs = store.listRuns({ project_id: project.id });
    // Numbered in the order new runs start, as the scheduler picks them: an issue whose run is going
    // on, or that already had its run since it was queued, isn't waiting to start.
    const queue = store
      .listIssues({ project_id: project.id, state: "open", queued: true })
      .filter((i) => !runs.some((r) => r.issue_number === i.number && (r.created_at >= i.queued_at! || !isTerminal(r.state))))
      .sort((a, b) => (a.queued_at! < b.queued_at! ? -1 : a.queued_at! > b.queued_at! ? 1 : (a.queue_seq ?? 0) - (b.queue_seq ?? 0)))
      .map((i) => i.number);
    const issues = store.listIssues({ project_id: project.id, state: "open" }).map((issue) => {
      // Newest first, so the first is the latest.
      const latest = runs.find((r) => r.issue_number === issue.number);
      const position = queue.indexOf(issue.number);
      return {
        number: issue.number,
        title: issue.title,
        author: issue.author,
        url: issue.url,
        labels: issue.labels,
        queued: issue.queued_at !== null,
        position: position === -1 ? null : position + 1,
        trusted: isTrustedIssue(config, issue),
        run: latest ? { id: latest.id, state: latest.state, waitingGate: latest.waiting_gate } : null,
      };
    });
    const synced = store.listIssues({ project_id: project.id }).reduce<string | null>((last, i) => (last === null || i.synced_at > last ? i.synced_at : last), null);
    return { github: project.github_repo, syncedAt: synced, issues };
  });

  app.post<{ Params: { key: string } }>("/api/projects/:key/sync", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const { store, project, config } = ctx;
    const result = syncIssues(store, project, options.run);
    const lines = reportLines(reconcileAndSweep(store, project, config, { run: options.run, github: options.github?.(project) }));
    changed(req.params.key);
    return { ...result, queued: store.listIssues({ project_id: project.id, queued: true }).length, lines };
  });

  app.post<{ Params: { key: string; n: string } }>("/api/projects/:key/issues/:n/queue", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const queued = ensureQueued(ctx, issueNumber(req.params.n), options.run);
    changed(req.params.key);
    return { number: queued.issue.number, queued: true, trusted: queued.trusted };
  });

  app.post<{ Params: { key: string; n: string } }>("/api/projects/:key/issues/:n/unqueue", async (req) => {
    const { store, project } = projects.byKey(req.params.key);
    const n = issueNumber(req.params.n);
    if (!store.getIssue(project.id, n)) throw new NotFoundError(`No issue #${n} in ${project.name}.`);
    store.setQueued(project.id, n, false);
    changed(req.params.key);
    return { number: n, queued: false };
  });

  app.get<{ Querystring: { view?: string; project?: string } }>("/api/runs", async (req) => {
    const view = (req.query.view ?? "active") as RunView;
    if (!["active", "waiting", "all"].includes(view)) throw new BadRequest(`Unknown view "${view}".`);
    const now = new Date().toISOString();
    const opened = req.query.project ? [{ key: req.query.project, ctx: projects.byKey(req.query.project) }] : projects.openAll();
    const runs = opened.flatMap(({ key, ctx }) =>
      ctx.store
        .listRuns({ project_id: ctx.project.id })
        .filter((run) => inView(run, view))
        .map((run) => ({ key, ctx, run })),
    );
    runs.sort((a, b) => (a.run.updated_at < b.run.updated_at ? 1 : a.run.updated_at > b.run.updated_at ? -1 : 0));
    // Rows cost a query or two each, so cut before building them.
    return (view === "all" ? runs.slice(0, ALL_LIMIT) : runs).map(({ key, ctx, run }) => rowOf(key, ctx, run, now));
  });

  type RunParams = { Params: { key: string; id: string } };
  app.get<RunParams>("/api/projects/:key/runs/:id", async (req): Promise<RunDetail> => {
    const ctx = projects.byKey(req.params.key);
    // Looked up here first, so an unknown run is a 404 and an id prefix or `#12` is no run.
    const run = runOf(ctx, req.params.id);
    const overview = runOverview(ctx.store, ctx.project, run.id);
    const redact = redactorOf(ctx, run);
    const row = rowOf(req.params.key, ctx, run, new Date().toISOString());
    const synced = run.issue_number === null ? undefined : ctx.store.getIssue(ctx.project.id, run.issue_number);
    return {
      run: { ...row, ...(row.reason === undefined ? {} : { reason: redact(row.reason) }) },
      issue: run.issue_number === null ? null : { number: run.issue_number, title: synced?.title ?? run.title, url: synced?.url ?? null },
      hasRunDir: overview.hasRunDir,
      files: overview.files,
      sections: overview.sections.map((s) => redactSection(s, redact)),
    };
  });

  // Asks GitHub, so only when a person opens the run's failed checks.
  app.get<RunParams>("/api/projects/:key/runs/:id/checks", async (req): Promise<RunChecksView> => {
    const ctx = projects.byKey(req.params.key);
    const run = runOf(ctx, req.params.id);
    const checks = runChecks(ctx, run.id, { run: options.run, github: options.github?.(ctx.project) });
    return { pr: checks.pr, failed: checks.failed, otherAlerts: checks.otherAlerts };
  });

  // The file's path may hold `/` (`round-1/checks.md`); resolveInRunDir alone decides what is inside the run folder.
  app.get<{ Params: { key: string; id: string; "*": string } }>("/api/projects/:key/runs/:id/files/*", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const run = runOf(ctx, req.params.id);
    const file = runFile(ctx.store, ctx.project, run.id, req.params["*"]);
    // A screenshot or other binary file has no text to show.
    if (file.text.includes(String.fromCharCode(0))) throw new BadRequest(`"${file.path}" is not a text file.`);
    return { path: file.path, text: redactorOf(ctx, run)(file.text) };
  });

  type RunAction = { Params: { key: string; id: string }; Body: unknown };
  const runAction = (name: string, act: (ctx: ProjectContext, run: Run, body: unknown) => object) =>
    app.post<RunAction>(`/api/projects/:key/runs/:id/${name}`, async (req) => {
      const ctx = projects.byKey(req.params.key);
      const run = runOf(ctx, req.params.id);
      expectShown(run, req.body);
      const result = act(ctx, run, req.body);
      changed(req.params.key);
      return result;
    });

  // After approve or resume the run sits in a working stage without a lease: the scheduler continues it.
  runAction("approve", (ctx, run, body) => {
    const approved = approveRun(ctx, run.id, { message: text(body, "message") }, options.run);
    return { run: approved.run, gate: approved.gate, to: approved.to, continuation: continuation(ctx.store, ctx.project, approved.run, approved.to) };
  });
  runAction("reject", (ctx, run, body) => {
    const rejected = rejectRun(ctx, run.id, { message: text(body, "message") ?? "" }, options.run);
    return { run: rejected.run, gate: rejected.gate, media: rejected.media, cleaned: rejected.cleaned };
  });
  runAction("resume", (ctx, run, body) => {
    const resumed = resumeRun(ctx, run.id, { to: text(body, "to") ?? "", message: text(body, "message") ?? "", resetLoops: flag(body, "resetLoops") }, options.run);
    return { run: resumed.run, to: resumed.to, continuation: continuation(ctx.store, ctx.project, resumed.run, resumed.to) };
  });
  // A human's decision about a false positive; GitHub may then pass the check, and the run goes back to merge.
  runAction("dismiss", (ctx, run, body) => {
    const alert = (body as Record<string, unknown> | null)?.alert;
    if (typeof alert !== "number" || !Number.isInteger(alert) || alert <= 0) throw new BadRequest("alert must be an alert number.");
    const deps = { run: options.run, github: options.github?.(ctx.project) };
    const dismissed = dismissAlert(ctx, run.id, { alert, reason: text(body, "reason") ?? "", comment: text(body, "comment") ?? "" }, deps);
    return {
      run: dismissed.run,
      alert: dismissed.alert,
      check: dismissed.check,
      failing: dismissed.failing,
      continued: dismissed.continued,
      ...(dismissed.continued ? { continuation: continuation(ctx.store, ctx.project, dismissed.run, "merge") } : {}),
    };
  });
  runAction("cancel", (ctx, run, body) => {
    const cancelled = cancelRun(ctx, run.id, text(body, "message")?.trim() || "cancelled from the web", { run: options.run, github: options.github?.(ctx.project) });
    return { run: cancelled.run, stopped: cancelled.stopped, media: cancelled.media, cleaned: cancelled.cleaned, ...(cancelled.closedPr ? { closedPr: cancelled.closedPr } : {}) };
  });

  draftRoutes(app, { projects, jobs: drafts, run: options.run, changed, limit: options.draftLimit });

  app.get("/api/scheduler", async () => options.scheduler?.status() ?? null);

  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    const unsubscribe = hub.subscribe(({ id, event }) => res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`));
    // Keeps proxies and the browser from giving up on a quiet stream.
    const beat = setInterval(() => res.write(": ping\n\n"), options.heartbeatMs ?? 20_000);
    // Stops writing before it ends: interrupted runs keep publishing while the server closes.
    const end = () => {
      if (!streams.delete(res)) return;
      clearInterval(beat);
      unsubscribe();
      res.end();
    };
    streams.set(res, end);
    req.raw.on("close", end);
  });
  // An open stream would keep close() waiting forever.
  app.addHook("preClose", async () => {
    for (const end of [...streams.values()]) end();
    // An issue writer nobody can follow any more; its draft stays for `factory new --list`.
    drafts.stopAll();
  });

  const webRoot = options.webRoot;
  const hasApp = webRoot !== undefined && existsSync(join(webRoot, "index.html"));
  const sendApp = (reply: FastifyReply) =>
    hasApp ? reply.sendFile("index.html") : reply.type("text/plain").send("The web app is not built. Run `pnpm build`.");
  if (hasApp) app.register(fastifyStatic, { root: webRoot, index: false });

  app.get("/", async (_req, reply) => sendApp(reply));

  app.setNotFoundHandler((req: FastifyRequest, reply) => {
    // Paths of the app's own screens get the app, which routes them itself.
    if (req.method === "GET" && !req.url.startsWith("/api/")) return sendApp(reply);
    return reply.code(404).send({ error: "Not found." });
  });

  return app;
}
