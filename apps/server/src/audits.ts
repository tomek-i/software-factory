import {
  auditHistory,
  findAudit,
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
import { NotFoundError, type ProjectSet } from "./projects.js";
import { RateLimiter, type RateLimit } from "./rate-limit.js";

/**
 * Asking for an audit spends a lot of usage, and filing opens issues: a page stuck in a loop must not
 * repeat either. Room for triaging a list of findings by hand, two requests each on a public repo.
 */
export const AUDIT_RATE_LIMIT: RateLimit = { max: 30, windowMs: 60_000 };

export interface AuditScheduler {
  status(): { audits: { path: string; state: "running" | "requested" | "failed"; error?: string }[] };
  /** Why it can't, or undefined once asked. */
  requestAudit(repoPath: string, name: string): string | undefined;
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
  const auditOf = (ctx: ProjectContext) => options.scheduler?.status().audits.find((a) => a.path === ctx.root);

  app.get<{ Params: { key: string } }>("/api/projects/:key/audits", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const redact = options.redact(ctx);
    const scheduled = auditOf(ctx);
    return {
      // Shown, not acted on: the scheduler reads the schedule from the default branch.
      schedule: ctx.config.security.audit_schedule,
      ...(scheduled?.state === "running" || scheduled?.state === "requested" ? { state: scheduled.state } : {}),
      // Why the last audit asked for or due could not start: nothing else records it.
      ...(scheduled?.state === "failed" && scheduled.error ? { failed: redact(scheduled.error) } : {}),
      github: ctx.project.github_repo,
      audits: auditHistory(ctx).map((a) => ({ ...summary(a, redact), findings: a.findings.length })),
    };
  });

  app.get<{ Params: { key: string; id: string } }>("/api/projects/:key/audits/:id", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const redact = options.redact(ctx);
    const audit = findAudit(ctx.project, req.params.id);
    if (!audit) throw new NotFoundError("No such audit: it may have been removed.");
    return {
      ...summary(audit, redact),
      findings: audit.findings.map((f) => {
        const issue = filedIssue(ctx.project, f.id);
        // The scan's agents wrote this: the page shows it as text only.
        return {
          id: f.id,
          severity: f.severity,
          claim: redact(f.claim),
          evidence: redact(f.evidence),
          ...(f.file ? { file: redact(f.file) } : {}),
          line: f.line,
          ...(issue === undefined ? {} : { issue }),
        };
      }),
    };
  });

  app.post<{ Params: { key: string } }>("/api/projects/:key/audits", limited, async (req, reply) => {
    const ctx = projects.byKey(req.params.key);
    if (!options.scheduler) throw new Conflict("Audits run in the scheduler, which isn't running.");
    const refused = options.scheduler.requestAudit(ctx.root, ctx.project.name);
    if (refused) throw new Conflict(refused);
    changed(req.params.key);
    return reply.code(202).send({ state: auditOf(ctx)?.state ?? "requested" });
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
        // gh's errors (a GithubError) as much as the service's can name local paths.
        if (err instanceof Error) err.message = options.redact(ctx)(err.message);
        if (err instanceof ServiceError && /already filed/.test(err.message)) throw new Conflict(err.message);
        throw err;
      }
    },
  );
}
