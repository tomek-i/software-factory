import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STAGES, type RunState } from "@factory/shared";
import { factoryDataDir } from "../github/attachments.js";
import { listRegistered, type RegistryEntry } from "../registry.js";
import { ServiceError } from "../service/errors.js";
import { openRegisteredProject, type ProjectContext } from "../service/project.js";
import { isAlive } from "../util/process.js";

/**
 * Who is working, for `factory upgrade`, which must not replace the factory under a running one.
 * A worker (`factory work`, `factory serve`) holds no lease while its queues are empty, so it says
 * it is running with a file of its own in the factory's data folder; a run being driven by any
 * process (a worker or `factory run`) holds a live lease in its project's store. While an upgrade
 * runs it holds a lock file, and a worker refuses to start.
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

export function upgradeLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(factoryDataDir(env), "upgrading.json");
}

/**
 * Says this process is a worker until the returned function is called. Refuses while an upgrade
 * holds its lock. The file is written before the lock is read, and an upgrade takes its lock
 * before it lists workers, so one of the two always sees the other.
 */
export function registerWorker(dir = workersDir(), pid = process.pid, lock = upgradeLockPath()): () => void {
  mkdirSync(dir, { recursive: true });
  // The suffix keeps two workers in one process (tests) from removing each other's file.
  const file = join(dir, `${pid}-${randomBytes(3).toString("hex")}.json`);
  writeAtomically(file, { pid, started_at: new Date().toISOString() });
  const release = () => rmSync(file, { force: true });
  const upgrading = livePid(lock);
  if (upgrading !== undefined) {
    release();
    throw new ServiceError(`\`factory upgrade\` is replacing the factory (pid ${upgrading}). Start this again once it has finished.`);
  }
  return release;
}

/**
 * Takes the upgrade lock until the returned function is called. A lock left by an upgrade that
 * died is taken over; one held by a live process is refused.
 */
export function takeUpgradeLock(lock = upgradeLockPath(), pid = process.pid): () => void {
  mkdirSync(dirname(lock), { recursive: true });
  const content = `${JSON.stringify({ pid, started_at: new Date().toISOString() })}\n`;
  for (let attempt = 0; ; attempt++) {
    try {
      // wx: of two upgrades starting at once, only one creates it.
      writeFileSync(lock, content, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw err;
      const holder = livePid(lock);
      if (holder !== undefined && holder !== pid) throw new ServiceError(`Another \`factory upgrade\` is running (pid ${holder}).`);
      rmSync(lock, { force: true });
    }
  }
  return () => {
    if (readPid(lock) === pid) rmSync(lock, { force: true });
  };
}

/**
 * Runs a worker (`factory work`, `factory serve`) registered for its whole life, from before it
 * opens the first database. An interrupted worker leaves its runs' drives behind with their
 * databases open, so it stays registered until the process exits.
 */
export async function asWorker<T extends { interrupted: boolean }>(fn: () => Promise<T>, register: () => () => void = registerWorker): Promise<T> {
  const unregister = register();
  let interrupted = false;
  try {
    const result = await fn();
    interrupted = result.interrupted;
    return result;
  } finally {
    if (interrupted) process.once("exit", unregister);
    else unregister();
  }
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

/** The pid in a presence or lock file when that process is alive and not this one. */
function livePid(file: string): number | undefined {
  const pid = existsSync(file) ? readPid(file) : undefined;
  return pid !== undefined && pid !== process.pid && isAlive(pid) ? pid : undefined;
}

function readPid(file: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    // Gone, or not ours: neither says a process holds it.
    return undefined;
  }
}

/** A rename, so a reader sees the whole file or none of it. */
function writeAtomically(file: string, data: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data)}\n`);
  renameSync(temp, file);
}

/**
 * Runs some process holds an unexpired lease on, across the registered projects. A project whose
 * repo or database has gone, or isn't set up, has nothing running; any other failure to read one
 * is thrown, since it might have.
 */
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
    } catch (err) {
      // openRegisteredProject reports exactly those cases as a ServiceError.
      if (err instanceof ServiceError) continue;
      throw err;
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
