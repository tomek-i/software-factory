import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { registryFileSchema, type RegistryEntry } from "@factory/shared";
import { FACTORY_DIR } from "./config/load.js";
import { factoryDataDir } from "./github/attachments.js";
import { ServiceError } from "./service/errors.js";
import type { CommandRunner } from "./util/exec.js";
import { mainCheckout } from "./util/git.js";

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
  /** How long a write waits for another process's lock before giving up. */
  lockTimeoutMs?: number;
}

// Long enough to outwait other processes' writes on a slow, virus-scanned disk, short enough not to
// hang a command for long.
const LOCK_TIMEOUT_MS = 10_000;
// A lock older than this was left by a process that died holding it: a write takes milliseconds.
const STALE_LOCK_MS = 30_000;
// Windows reports a file that is being deleted or scanned as EPERM/EACCES/EBUSY for a moment.
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(factoryDataDir(env), "projects.json");
}

/** Whether two paths name the same repo: separators and `..` normalised, case ignored on Windows. */
export function sameProjectPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = (p: string) => (platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return key(a) === key(b);
}

export function projectStatus(path: string): ProjectStatus {
  if (!existsSync(path)) return "missing_repo";
  return existsSync(join(path, FACTORY_DIR, "factory.db")) ? "ok" : "missing_db";
}

/**
 * The repo containing cwd when it has a factory database but is not in the project list (set up
 * before the list existed, or removed from it), so a command can say to run `factory init` there
 * rather than that nothing is registered. Undefined outside a repo, or for one in the list.
 */
export function unregisteredRepo(cwd: string, registered: { path: string }[], run?: CommandRunner): string | undefined {
  const checkout = mainCheckout(cwd, run);
  if (checkout === undefined) return undefined;
  const root = resolve(checkout);
  if (projectStatus(root) !== "ok") return undefined;
  return registered.some((e) => sameProjectPath(e.path, root)) ? undefined : root;
}

/** What to tell someone standing in an `unregisteredRepo`. Adding it stays their explicit `factory init`. */
export function unregisteredHint(root: string): string {
  return `This repository (${root}) has a factory database but is not in your project list. Run \`factory init\` here to add it (your config is kept).`;
}

export function listRegistered(options: RegistryOptions = {}): RegisteredProject[] {
  return readEntries(options.file ?? registryPath()).map((e) => ({ ...e, status: projectStatus(e.path) }));
}

/** Adds a repo, or updates its name. Safe to call on every `factory init`. */
export function registerProject(project: { path: string; name: string }, options: RegistryOptions = {}): "added" | "updated" | "unchanged" {
  return update(options, (entries) => {
    const existing = entries.find((e) => sameProjectPath(e.path, project.path));
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
  const removed = update(options, (entries) => {
    const index = entries.findIndex((e) => sameProjectPath(e.path, path));
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
function update<T>(options: RegistryOptions, change: (entries: RegistryEntry[]) => T): T {
  const file = options.file ?? registryPath();
  mkdirSync(dirname(file), { recursive: true });
  return withLock(`${file}.lock`, options.lockTimeoutMs ?? LOCK_TIMEOUT_MS, () => {
    const entries = readEntries(file);
    const before = JSON.stringify(entries);
    const result = change(entries);
    if (JSON.stringify(entries) !== before) writeAtomically(file, `${JSON.stringify({ version: 1, projects: entries }, null, 2)}\n`);
    return result;
  });
}

/**
 * The lock file holds a token unique to its holder, so a holder only ever removes its own lock, and
 * a process taking over a stale lock can tell whether it moved the stale one or a fresh one.
 */
function withLock<T>(lock: string, timeoutMs: number, fn: () => T): T {
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx" });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (code !== "EEXIST" && !BUSY.has(code)) throw err;
      if (code === "EEXIST") {
        const held = readLock(lock);
        if (held !== undefined && held.age > STALE_LOCK_MS) {
          takeOverStale(lock, held.token, token);
          continue;
        }
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
    if (readLock(lock)?.token === token) rmSync(lock, { force: true });
  }
}

function readLock(lock: string): { token: string; age: number } | undefined {
  try {
    return { token: readFileSync(lock, "utf8"), age: Date.now() - statSync(lock).mtimeMs };
  } catch {
    // Released between our attempt and the read: try again.
    return undefined;
  }
}

/**
 * Moves a stale lock aside. A rename succeeds for one process only, so two processes that both
 * found it stale can't both proceed. If the lock was replaced by a live one in the meantime, it is
 * put back where it was.
 */
function takeOverStale(lock: string, staleToken: string, ourToken: string): void {
  const aside = `${lock}.${ourToken}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return;
  }
  let moved: string | undefined;
  try {
    moved = readFileSync(aside, "utf8");
  } catch {
    moved = undefined;
  }
  if (moved !== staleToken) {
    try {
      // Fails if another process has created a lock since; that one holds it then.
      linkSync(aside, lock);
    } catch {
      // Nothing to restore over.
    }
  }
  rmSync(aside, { force: true });
}

function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    // Flushed before the rename, so a power cut can't leave an empty list behind the new name.
    const fd = openSync(temp, "w");
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temp, file);
        return;
      } catch (err) {
        if (attempt >= 20 || !BUSY.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
        sleep(25);
      }
    }
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** Callers are synchronous CLI paths, so wait without an event loop. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
