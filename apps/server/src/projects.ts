import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { listRegistered, openRegisteredProject, projectStatus, type ProjectContext, type ProjectStatus, type RegistryEntry } from "@factory/core";

export class NotFoundError extends Error {}

export interface ProjectInfo {
  key: string;
  name: string;
  path: string;
  status: ProjectStatus | "error";
  /** Why it can't be opened, when it can't. */
  problem?: string;
}

/** A stable id for a project in URLs, from its path, normalised as sameProjectPath does. */
export function projectKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return createHash("sha256")
    .update(platform === "win32" ? resolve(path).toLowerCase() : resolve(path))
    .digest("hex")
    .slice(0, 12);
}

/**
 * The registered projects, each opened once and shared by the routes and the scheduler, so both
 * work on the same store. Read from the project list on every call: a project can be registered
 * while the server runs.
 */
export class ProjectSet {
  private readonly opened = new Map<string, ProjectContext>();

  constructor(
    private readonly list: () => RegistryEntry[] = listRegistered,
    private readonly openEntry: (entry: RegistryEntry) => ProjectContext = openRegisteredProject,
  ) {}

  entries(): RegistryEntry[] {
    return this.list();
  }

  /** Opens the project the first time; also the scheduler's `open`. */
  open(entry: RegistryEntry): ProjectContext {
    const key = projectKey(entry.path);
    const known = this.opened.get(key);
    if (known) return known;
    const ctx = this.openEntry(entry);
    this.opened.set(key, ctx);
    return ctx;
  }

  info(): ProjectInfo[] {
    return this.entries().map((entry) => {
      const base = { key: projectKey(entry.path), name: entry.name, path: entry.path };
      const status = projectStatus(entry.path);
      if (status !== "ok") return { ...base, status };
      try {
        this.open(entry);
        return { ...base, status };
      } catch (err) {
        return { ...base, status: "error", problem: (err as Error).message };
      }
    });
  }

  /** Every project that opens, with its key. */
  openAll(): { key: string; ctx: ProjectContext }[] {
    const result: { key: string; ctx: ProjectContext }[] = [];
    for (const entry of this.entries()) {
      try {
        result.push({ key: projectKey(entry.path), ctx: this.open(entry) });
      } catch {
        // info() lists it with its problem; it has no runs to show.
      }
    }
    return result;
  }

  byKey(key: string): ProjectContext {
    const entry = this.entries().find((e) => projectKey(e.path) === key);
    if (!entry) throw new NotFoundError(`No project ${key}.`);
    return this.open(entry);
  }

  close(): void {
    for (const ctx of this.opened.values()) ctx.store.close();
    this.opened.clear();
  }
}
