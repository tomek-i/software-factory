import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot, loadConfig, Store, type Project, type CommandRunner } from "@factory/core";
import type { FactoryConfig } from "@factory/shared";

export class CliError extends Error {}

export interface ProjectContext {
  root: string;
  config: FactoryConfig;
  store: Store;
  project: Project;
}

/** Open the CLI-mode store for the repo containing cwd. Callers must close ctx.store. */
export function openProject(cwd: string, run?: CommandRunner): ProjectContext {
  const root = findRepoRoot(cwd, run);
  if (!root) throw new CliError("Not inside a git repository.");
  const config = loadConfig(root);
  const dbPath = join(root, ".factory", "factory.db");
  // Opening a Store creates the file, so check first rather than leaving an empty db behind
  // (e.g. when run inside one of the factory's own worktrees).
  if (!existsSync(dbPath)) throw new CliError("This repository is not registered. Run `factory init` first.");
  const store = new Store(dbPath);
  const project = store.listProjects().find((p) => p.repo_path === root);
  if (!project) {
    store.close();
    throw new CliError("This repository is not registered. Run `factory init` first.");
  }
  return { root, config, store, project };
}

export function withProject<T>(cwd: string, fn: (ctx: ProjectContext) => T, run?: CommandRunner): T {
  const ctx = openProject(cwd, run);
  try {
    return fn(ctx);
  } finally {
    ctx.store.close();
  }
}

export async function withProjectAsync<T>(cwd: string, fn: (ctx: ProjectContext) => Promise<T>, run?: CommandRunner): Promise<T> {
  const ctx = openProject(cwd, run);
  try {
    return await fn(ctx);
  } finally {
    ctx.store.close();
  }
}
