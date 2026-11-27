import {
  auditById,
  auditHistory,
  fileAuditFinding,
  filedIssue,
  PublicRepoError,
  ServiceError,
  type AuditPort,
  type AuditRecord,
  type CommandRunner,
  type Project,
  type ProjectContext,
} from "@factory/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Conflict } from "./errors.js";
import type { ProjectSet } from "./projects.js";
import { RateLimiter, type RateLimit } from "./rate-limit.js";

/** Asking for an audit spends a lot of usage, and filing opens issues: a page stuck in a loop must not repeat either. */
export const AUDIT_RATE_LIMIT: RateLimit = { max: 10, windowMs: 60_000 };

export interface AuditScheduler {
  status(): { audits: { path: string; state: "running" | "requested" }[] };
  requestAudit(repoPath: string, name: string): boolean;
}

export interface AuditRouteOptions {
  projects: ProjectSet;
  run?: CommandRunner;
  /** Runs the audits; without one (tests of other routes) nothing can be asked for. */
  scheduler?: AuditScheduler;
  /** Files findings as issues; `gh` by default. */
  github?: (project: Project) => AuditPort | undefined;
  changed: (project?: string) => void;
  /** Shortens local paths in what the page shows. */
  redact: (ctx: ProjectContext) => (text: string) => string;
  limit?: RateLimit;
}

function summary(audit: AuditRecord, redact: (text: string) => string) {
  return {
    id: audit.id,
    startedAt: audit.started_at,
    finishedAt: audit.finished_at,
    commit: audit.commit,
    effort: audit.effort,
    status: audit.status,
    ...(audit.problem ? { problem: redact(audit.problem) } : {}),
    notes: audit.notes.map(redact),
  };
}

/** The Audits screen's API over the audits `factory audit` and the scheduler record. */
export function auditRoutes(app: FastifyInstance, options: AuditRouteOptions): void {
  const { projects, run, changed } = options;
  const limiter = new RateLimiter(options.limit ?? AUDIT_RATE_LIMIT);
  // A route hook: the server's own Host, token and Origin checks run first, so only the app's page counts.
  const limited = { onRequest: async (req: FastifyRequest) => limiter.take(`${req.method} ${req.routeOptions.url}`) };
  const stateOf = (ctx: ProjectContext) => options.scheduler?.status().audits.find((a) => a.path === ctx.root)?.state;

  app.get<{ Params: { key: string } }>("/api/projects/:key/audits", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const redact = options.redact(ctx);
    const state = stateOf(ctx);
    return {
      // Shown, not acted on: the scheduler reads the schedule from the default branch.
      schedule: ctx.config.security.audit_schedule,
      ...(state ? { state } : {}),
      github: ctx.project.github_repo,
      audits: auditHistory(ctx).map((a) => ({ ...summary(a, redact), findings: a.findings.length })),
    };
  });

  app.get<{ Params: { key: string; id: string } }>("/api/projects/:key/audits/:id", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const redact = options.redact(ctx);
    const audit = auditById(ctx, req.params.id);
    return {
      ...summary(audit, redact),
      findings: audit.findings.map((f) => {
        const issue = filedIssue(ctx.project, f.id);
        // The scan's agents wrote this: the page shows it as text only.
        return { id: f.id, severity: f.severity, claim: f.claim, evidence: redact(f.evidence), file: f.file, line: f.line, ...(issue === undefined ? {} : { issue }) };
      }),
    };
  });

  app.post<{ Params: { key: string } }>("/api/projects/:key/audits", limited, async (req, reply) => {
    const ctx = projects.byKey(req.params.key);
    if (!options.scheduler) throw new Conflict("Audits run in the scheduler, which isn't running.");
    if (!options.scheduler.requestAudit(ctx.root, ctx.project.name)) throw new Conflict("An audit of this project is already going on or waiting to start.");
    changed(req.params.key);
    return reply.code(202).send({ state: stateOf(ctx) ?? "requested" });
  });

  app.post<{ Params: { key: string; id: string; finding: string }; Body: unknown }>(
    "/api/projects/:key/audits/:id/findings/:finding/file",
    limited,
    async (req, reply) => {
      const ctx = projects.byKey(req.params.key);
      const allowPublic = ((req.body ?? {}) as Record<string, unknown>).public === true;
      try {
        const filed = fileAuditFinding(ctx, { audit: req.params.id, finding: req.params.finding, allowPublic }, { run, github: options.github?.(ctx.project) });
        changed(req.params.key);
        return { issue: filed.issue };
      } catch (err) {
        // The page asks the person, then sends public: true.
        if (err instanceof PublicRepoError) return reply.code(409).send({ error: err.message, code: "public_repo" });
        if (err instanceof ServiceError) err.message = options.redact(ctx)(err.message);
        throw err;
      }
    },
  );
}
