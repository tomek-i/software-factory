import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGES, type RunState } from "@factory/shared";
import { factoryDataDir } from "../github/attachments.js";
import { listRegistered, type RegistryEntry } from "../registry.js";
import { openRegisteredProject, type ProjectContext } from "../service/project.js";
import { isAlive } from "../util/process.js";

/**
 * Who is working, for `factory upgrade`, which must not replace the factory under a running one.
 * A worker (`factory work`, `factory serve`) holds no lease while its queues are empty, so it says
 * it is running with a file of its own in the factory's data folder; a run being driven by any
 * process (a worker or `factory run`) holds a live lease in its project's store.
 */

export interface LiveWorker {
  pid: number;
  /** Its presence file, to delete by hand if that pid now belongs to another program. */
  file: string;
}

export interface LiveLease {
  project: string;
  runId: string;
  issue: number | null;
  owner: string;
}

const WORKING: RunState[] = [...STAGES];

export function workersDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(factoryDataDir(env), "workers");
}

/** Says this process is a worker until the returned function is called. */
export function registerWorker(dir = workersDir(), pid = process.pid): () => void {
  mkdirSync(dir, { recursive: true });
  // The suffix keeps two schedulers in one process (tests) from removing each other's file.
  const file = join(dir, `${pid}-${randomBytes(3).toString("hex")}.json`);
  writeFileSync(file, `${JSON.stringify({ pid, started_at: new Date().toISOString() })}\n`);
  return () => rmSync(file, { force: true });
}

/**
 * Workers whose process is still alive. A file left by one that crashed is removed: its process is
 * gone, so it can't be holding anything.
 */
export function liveWorkers(dir = workersDir(), alive: (pid: number) => boolean = isAlive): LiveWorker[] {
  if (!existsSync(dir)) return [];
  const found: LiveWorker[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const pid = readPid(file);
    if (pid === undefined) continue;
    if (pid !== process.pid && alive(pid)) found.push({ pid, file });
    else if (pid !== process.pid) rmSync(file, { force: true });
  }
  return found;
}

function readPid(file: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    // Being written, or not ours: neither says a worker runs.
    return undefined;
  }
}

/** Runs some process holds an unexpired lease on, across the registered projects that open. */
export function liveLeases(
  projects: () => RegistryEntry[] = listRegistered,
  open: (entry: RegistryEntry) => ProjectContext = openRegisteredProject,
  now = Date.now(),
): LiveLease[] {
  const nowIso = new Date(now).toISOString();
  const found: LiveLease[] = [];
  for (const entry of projects()) {
    let ctx: ProjectContext;
    try {
      ctx = open(entry);
    } catch {
      continue; // a project that doesn't open has nothing running either
    }
    try {
      for (const run of ctx.store.listRuns({ project_id: ctx.project.id, states: WORKING })) {
        if (run.lease_owner === null || run.lease_expires_at === null || run.lease_expires_at < nowIso) continue;
        found.push({ project: entry.name, runId: run.id, issue: run.issue_number, owner: run.lease_owner });
      }
    } finally {
      ctx.store.close();
    }
  }
  return found;
}
