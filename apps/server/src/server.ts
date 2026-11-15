import { existsSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import {
  approveRun,
  cancelRun,
  continuation,
  ensureQueued,
  GithubError,
  reconcileAndSweep,
  rejectRun,
  reportLines,
  resumeRun,
  resumeTargets,
  runCost,
  ServiceError,
  syncIssues,
  type CommandRunner,
  type GithubPort,
  type Project,
  type ProjectContext,
  type Run,
  type SchedulerStatus,
} from "@factory/core";
import { isTerminal, isTrustedIssue } from "@factory/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { EventHub } from "./hub.js";
import { NotFoundError, type ProjectSet } from "./projects.js";
import { cookieValue, hostAllowed, originAllowed, SESSION_COOKIE, sessionCookie, tokenMatches } from "./security.js";

export interface ServerOptions {
  projects: ProjectSet;
  hub: EventHub;
  /** The session token: the link `factory serve` prints carries it. */
  token: string;
  /** The port the browser uses, for the Host and Origin checks. Once listening, the real one is used. */
  port: number;
  scheduler?: { status(): SchedulerStatus };
  run?: CommandRunner;
  github?: (project: Project) => GithubPort | undefined;
  /** The built web app; none serves the API only. */
  webRoot?: string;
  /** Where unexpected errors go: the terminal, never the browser. */
  log?: (line: string) => void;
  heartbeatMs?: number;
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
  cost: number;
  /** A worker holds its lease: something is driving it right now. */
  held: boolean;
  updatedAt: string;
  /** Why it is where it is: the reason of its last move. */
  reason?: string;
  /** Where a run parked for a human can be sent. */
  resumeTargets: Run["state"][];
}

const WAITING: Run["state"][] = ["needs_human", "needs_info"];
const ALL_LIMIT = 200;

class BadRequest extends Error {}

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

function rowOf(key: string, ctx: ProjectContext, run: Run, now: string): RunRow {
  const events = ctx.store.listEvents(run.id);
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
    cost: runCost(ctx.store, run.id),
    held: run.lease_expires_at !== null && run.lease_expires_at > now,
    updatedAt: run.updated_at,
    reason: events.at(-1)?.reason,
    resumeTargets: run.state === "needs_human" ? resumeTargets(run) : [],
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
  const streams = new Set<ServerResponse>();

  const port = () => {
    const address = app.server.address();
    return address && typeof address === "object" ? address.port : options.port;
  };
  const changed = (project?: string) => hub.publish({ type: "changed", project });

  app.addHook("onRequest", async (req, reply) => {
    if (!hostAllowed(req.headers.host, port())) return reply.code(403).type("text/plain").send("Forbidden host.");
    if (req.method !== "GET" && req.method !== "HEAD" && !originAllowed(req.headers.origin, port())) {
      return reply.code(403).send({ error: "Forbidden origin." });
    }
    if (req.url.startsWith("/api/") && !tokenMatches(cookieValue(req.headers.cookie, SESSION_COOKIE), token)) {
      return reply.code(401).send({ error: "Open the link `factory serve` printed." });
    }
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
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
    const queue = store.listIssues({ project_id: project.id, queued: true }).map((i) => i.number);
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
    const rows = opened.flatMap(({ key, ctx }) =>
      ctx.store
        .listRuns({ project_id: ctx.project.id })
        .filter((run) => inView(run, view))
        .map((run) => rowOf(key, ctx, run, now)),
    );
    rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return view === "all" ? rows.slice(0, ALL_LIMIT) : rows;
  });

  type RunAction = { Params: { key: string; id: string }; Body: unknown };
  const runAction = (name: string, act: (ctx: ProjectContext, run: Run, body: unknown) => object) =>
    app.post<RunAction>(`/api/projects/:key/runs/:id/${name}`, async (req) => {
      const ctx = projects.byKey(req.params.key);
      const result = act(ctx, runOf(ctx, req.params.id), req.body);
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
    const resumed = resumeRun(ctx, run.id, { to: text(body, "to") ?? "", message: text(body, "message") ?? "" }, options.run);
    return { run: resumed.run, to: resumed.to, continuation: continuation(ctx.store, ctx.project, resumed.run, resumed.to) };
  });
  runAction("cancel", (ctx, run, body) => {
    const cancelled = cancelRun(ctx, run.id, text(body, "message")?.trim() || "cancelled from the web", options.run);
    return { run: cancelled.run, stopped: cancelled.stopped, media: cancelled.media, cleaned: cancelled.cleaned };
  });

  app.get("/api/scheduler", async () => options.scheduler?.status() ?? null);

  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(": connected\n\n");
    streams.add(res);
    const unsubscribe = hub.subscribe(({ id, event }) => res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`));
    // Keeps proxies and the browser from giving up on a quiet stream.
    const beat = setInterval(() => res.write(": ping\n\n"), options.heartbeatMs ?? 20_000);
    req.raw.on("close", () => {
      clearInterval(beat);
      unsubscribe();
      streams.delete(res);
    });
  });
  // An open stream would keep close() waiting forever.
  app.addHook("preClose", async () => {
    for (const res of streams) res.end();
  });

  const webRoot = options.webRoot;
  const hasApp = webRoot !== undefined && existsSync(join(webRoot, "index.html"));
  const sendApp = (reply: FastifyReply) =>
    hasApp ? reply.sendFile("index.html") : reply.type("text/plain").send("The web app is not built. Run `pnpm build`.");
  if (hasApp) app.register(fastifyStatic, { root: webRoot, index: false });

  app.get<{ Querystring: { token?: string } }>("/", async (req, reply) => {
    const given = req.query.token;
    if (given !== undefined) {
      if (!tokenMatches(given, token)) return reply.code(401).type("text/plain").send("This link is out of date. Open the one `factory serve` printed last.");
      // The token leaves the address bar: the cookie carries the session from here on.
      return reply.header("Set-Cookie", sessionCookie(token)).redirect("/");
    }
    return sendApp(reply);
  });

  app.setNotFoundHandler((req: FastifyRequest, reply) => {
    // Paths of the app's own screens get the app, which routes them itself.
    if (req.method === "GET" && !req.url.startsWith("/api/")) return sendApp(reply);
    return reply.code(404).send({ error: "Not found." });
  });

  return app;
}
