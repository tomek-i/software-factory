import { join } from "node:path";
import type { FactoryConfig } from "@factory/shared";
import { FACTORY_DIR, loadConfig } from "../config/load.js";
import { projectStatus, samePath } from "../registry.js";
import { Store, type Project } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { findRepoRoot } from "../util/git.js";
import { ServiceError } from "./errors.js";

export interface ProjectContext {
  root: string;
  config: FactoryConfig;
  store: Store;
  project: Project;
}

const NOT_REGISTERED = "This repository is not registered. Run `factory init` first.";

/** Open the store of the repo containing cwd. Callers must close ctx.store. */
export function openProject(cwd: string, run?: CommandRunner): ProjectContext {
  const root = findRepoRoot(cwd, run);
  if (!root) throw new ServiceError("Not inside a git repository.");
  const config = loadConfig(root);
  // Opening a Store creates the file, so check first rather than leaving an empty db behind
  // (e.g. when run inside one of the factory's own worktrees).
  if (projectStatus(root) !== "ok") throw new ServiceError(NOT_REGISTERED);
  return openStore(root, config, NOT_REGISTERED);
}

/**
 * Open a project from its entry in the project list, for a worker that is not inside the repo. A
 * repo or database that has gone is reported, never created.
 */
export function openRegisteredProject(entry: { path: string }): ProjectContext {
  const status = projectStatus(entry.path);
  if (status === "missing_repo") throw new ServiceError(`The repository ${entry.path} no longer exists. Drop it with \`factory projects remove\`.`);
  if (status === "missing_db") throw new ServiceError(`${entry.path} has no ${FACTORY_DIR}/factory.db. Run \`factory init\` there.`);
  return openStore(entry.path, loadConfig(entry.path), `${entry.path} is not set up in its ${FACTORY_DIR}/factory.db. Run \`factory init\` there.`);
}

function openStore(root: string, config: FactoryConfig, notFound: string): ProjectContext {
  const store = new Store(join(root, FACTORY_DIR, "factory.db"));
  const project = store.listProjects().find((p) => samePath(p.repo_path, root));
  if (!project) {
    store.close();
    throw new ServiceError(notFound);
  }
  return { root, config, store, project };
}
