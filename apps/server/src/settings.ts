import { readSettings, saveSettings, ServiceError, type CommandRunner, type ConfigChange, type ProjectContext } from "@factory/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { BadRequest } from "./errors.js";
import type { ProjectSet } from "./projects.js";
import { RateLimiter, type RateLimit } from "./rate-limit.js";

/** Saving pushes a commit, so a page stuck in a loop must not flood the default branch. */
export const SETTINGS_RATE_LIMIT: RateLimit = { max: 10, windowMs: 60_000 };

export interface SettingsRouteOptions {
  projects: ProjectSet;
  run?: CommandRunner;
  changed: (project?: string) => void;
  /** Shortens local paths in what the page shows. */
  redact: (ctx: ProjectContext) => (text: string) => string;
  /** Told after a save, so the next run starts with the new settings rather than a cached copy. */
  forgetConfig?: (repoPath: string) => void;
  limit?: RateLimit;
}

/** `{ head, changes }`: the commit the page read the settings at, and each change it made. */
function saveRequest(body: unknown): { head: string; changes: ConfigChange[] } {
  const record = (body ?? {}) as Record<string, unknown>;
  if (typeof record.head !== "string" || !/^[0-9a-f]{40,64}$/.test(record.head)) throw new BadRequest("Say which commit the settings were read at (head).");
  if (!Array.isArray(record.changes) || record.changes.length === 0 || record.changes.length > 100) {
    throw new BadRequest("Give the settings to change (changes).");
  }
  const changes = record.changes.map((c: unknown): ConfigChange => {
    const change = (c ?? {}) as Record<string, unknown>;
    if (typeof change.path !== "string") throw new BadRequest("Each change names its setting (path).");
    if (change.reset === true && !("value" in change)) return { path: change.path, reset: true };
    if ("value" in change && change.reset === undefined) return { path: change.path, value: change.value };
    throw new BadRequest(`${change.path}: give either a value or reset: true.`);
  });
  return { head: record.head, changes };
}

/** The Settings screen's API: a project's `.factory/config.yaml` as it is on its default branch. */
export function settingsRoutes(app: FastifyInstance, options: SettingsRouteOptions): void {
  const { projects, run, changed } = options;
  const limiter = new RateLimiter(options.limit ?? SETTINGS_RATE_LIMIT);
  // A route hook: the server's own Host, token and Origin checks run first, so only the app's page counts.
  const limited = { onRequest: async (req: FastifyRequest) => limiter.take(`${req.method} ${req.routeOptions.url}`) };

  app.get<{ Params: { key: string } }>("/api/projects/:key/settings", async (req) => {
    const ctx = projects.byKey(req.params.key);
    const settings = readSettings(ctx, run);
    return { ...settings, problems: settings.problems.map(options.redact(ctx)) };
  });

  app.put<{ Params: { key: string }; Body: unknown }>("/api/projects/:key/settings", limited, async (req) => {
    const ctx = projects.byKey(req.params.key);
    const redact = options.redact(ctx);
    let saved;
    try {
      saved = saveSettings(ctx, saveRequest(req.body), run);
    } catch (err) {
      // Hook and git output can name the temporary worktree or the repo.
      if (err instanceof ServiceError) err.message = redact(err.message);
      throw err;
    }
    // The routes read the context's config (trust, for one): give them the settings just saved, but
    // keep the branch the working copy named, which every trusted read and save goes to.
    ctx.config = { ...saved.config, project: { ...saved.config.project, default_branch: ctx.config.project.default_branch } };
    options.forgetConfig?.(ctx.root);
    changed(req.params.key);
    return { commit: saved.commit, branch: saved.branch, changed: saved.changed };
  });
}
