import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot, listRegistered, ServiceError, unregisterProject, type CommandRunner, type ProjectStatus, type RegistryOptions } from "@factory/core";
import { CliError } from "../context.js";
import { plain, type Style } from "../style.js";

const PROBLEM: Record<Exclude<ProjectStatus, "ok">, string> = {
  missing_repo: "(folder missing)",
  missing_db: "(not initialised: no .factory/factory.db)",
};

/** Returns the text to print, so the command can be tested without capturing stdout. */
export function runProjects(options: RegistryOptions = {}, style: Style = plain): string {
  const projects = cli(() => listRegistered(options));
  if (projects.length === 0) return `No projects registered. Run ${style.hint("`factory init`")} in a repository.`;
  return projects
    .map((p) => {
      const line = `${p.name}  ${style.detail(p.path)}`;
      return p.status === "ok" ? line : `${line}  ${style.attention(PROBLEM[p.status])}`;
    })
    .join("\n");
}

export function runProjectsRemove(cwd: string, path: string, options: RegistryOptions = {}, run?: CommandRunner): string {
  const target = resolve(cwd, path);
  // The list holds repo roots, so `remove .` from a subfolder means its repo. A folder that has
  // gone (the usual reason to remove one) is taken as it is.
  const root = existsSync(target) ? (findRepoRoot(target, run) ?? target) : target;
  const removed = cli(() => unregisterProject(root, options));
  return `Removed ${removed.path} from the project list (the repository and its database are untouched).`;
}

function cli<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw err instanceof ServiceError ? new CliError(err.message) : err;
  }
}
