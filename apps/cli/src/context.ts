import { openProject as openCoreProject, ServiceError, type CommandRunner, type ProjectContext } from "@factory/core";

export type { ProjectContext } from "@factory/core";

export class CliError extends Error {}

/** A core ServiceError as a CliError with the same message, so it prints and exits like one. */
function asCliError(err: unknown): unknown {
  return err instanceof ServiceError ? new CliError(err.message) : err;
}

/** Open the CLI-mode store for the repo containing cwd. Callers must close ctx.store. */
export function openProject(cwd: string, run?: CommandRunner): ProjectContext {
  try {
    return openCoreProject(cwd, run);
  } catch (err) {
    throw asCliError(err);
  }
}

export function withProject<T>(cwd: string, fn: (ctx: ProjectContext) => T, run?: CommandRunner): T {
  const ctx = openProject(cwd, run);
  try {
    return fn(ctx);
  } catch (err) {
    throw asCliError(err);
  } finally {
    ctx.store.close();
  }
}

export async function withProjectAsync<T>(cwd: string, fn: (ctx: ProjectContext) => Promise<T>, run?: CommandRunner): Promise<T> {
  const ctx = openProject(cwd, run);
  try {
    return await fn(ctx);
  } catch (err) {
    throw asCliError(err);
  } finally {
    ctx.store.close();
  }
}
