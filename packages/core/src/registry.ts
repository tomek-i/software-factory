import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registryFileSchema, type RegistryEntry } from "@factory/shared";
import { FACTORY_DIR } from "./config/load.js";
import { factoryDataDir } from "./github/attachments.js";
import { ServiceError } from "./service/errors.js";

/**
 * The repos this user's factory manages, so a long-running worker or the web server can find every
 * project's `factory.db`. One file per user, next to the GitHub browser profile; it holds only paths
 * and names, the state stays in each repo.
 */

export type { RegistryEntry } from "@factory/shared";
export type ProjectStatus = "ok" | "missing_repo" | "missing_db";
export interface RegisteredProject extends RegistryEntry {
  status: ProjectStatus;
}

export interface RegistryOptions {
  /** The registry file; defaults to `registryPath()`. */
  file?: string;
}

// Long enough to outwait another process's read-modify-write, short enough not to hang a command.
const LOCK_TIMEOUT_MS = 5_000;
// A lock older than this was left by a process that died holding it.
const STALE_LOCK_MS = 30_000;

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(factoryDataDir(env), "projects.json");
}

/** Whether two paths name the same repo: separators and `..` normalised, case ignored on Windows. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = (p: string) => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return key(a) === key(b);
}

export function projectStatus(path: string): ProjectStatus {
  if (!existsSync(path)) return "missing_repo";
  return existsSync(join(path, FACTORY_DIR, "factory.db")) ? "ok" : "missing_db";
}

export function listRegistered(options: RegistryOptions = {}): RegisteredProject[] {
  return readEntries(options.file ?? registryPath()).map((e) => ({ ...e, status: projectStatus(e.path) }));
}

/** Adds a repo, or updates its name. Safe to call on every `factory init`. */
export function registerProject(project: { path: string; name: string }, options: RegistryOptions = {}): "added" | "updated" | "unchanged" {
  return update(options.file ?? registryPath(), (entries) => {
    const existing = entries.find((e) => samePath(e.path, project.path));
    if (!existing) {
      entries.push({ path: project.path, name: project.name, added_at: new Date().toISOString() });
      return "added";
    }
    if (existing.name === project.name) return "unchanged";
    existing.name = project.name;
    return "updated";
  });
}

/** Drops a repo from the list. The repo and its database are never touched. Returns the entry removed. */
export function unregisterProject(path: string, options: RegistryOptions = {}): RegistryEntry {
  const file = options.file ?? registryPath();
  const removed = update(file, (entries) => {
    const index = entries.findIndex((e) => samePath(e.path, path));
    return index === -1 ? undefined : entries.splice(index, 1)[0];
  });
  if (!removed) throw new ServiceError(`Not in the project list: ${path}`);
  return removed;
}

function readEntries(file: string): RegistryEntry[] {
  if (!existsSync(file)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw corrupt(file, err instanceof Error ? err.message : String(err));
  }
  const parsed = registryFileSchema.safeParse(data);
  // Never replaced silently: rewriting a file we can't read would drop every project in it.
  if (!parsed.success) throw corrupt(file, parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; "));
  return parsed.data.projects;
}

function corrupt(file: string, why: string): ServiceError {
  return new ServiceError(`The project list ${file} is not valid (${why}). Fix it or delete it, then run \`factory init\` in each repository again.`);
}

/**
 * Read, change and write the file under a lock. A rename alone keeps readers from seeing half a
 * file, but two processes registering at once would each write their own copy and one would be lost.
 */
function update<T>(file: string, change: (entries: RegistryEntry[]) => T): T {
  mkdirSync(dirname(file), { recursive: true });
  return withLock(`${file}.lock`, () => {
    const entries = readEntries(file);
    const before = JSON.stringify(entries);
    const result = change(entries);
    if (JSON.stringify(entries) !== before) writeAtomically(file, `${JSON.stringify({ version: 1, projects: entries }, null, 2)}\n`);
    return result;
  });
}

function withLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lockAge(lock) > STALE_LOCK_MS) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new ServiceError(`The project list is locked by another factory process (${lock}). If none is running, delete that file.`);
      }
      sleep(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function lockAge(lock: string): number {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    // Released between our attempt and the stat: young enough to just try again.
    return 0;
  }
}

function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  // Windows refuses to replace a file another process has open for a moment (a reader, antivirus).
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(temp, { force: true });
        throw err;
      }
      sleep(25);
    }
  }
}

/** Callers are synchronous CLI paths, so wait without an event loop. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
