import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { factoryDataDir } from "../github/attachments.js";

/**
 * `factory stop` asks every running worker (`factory work`, `factory serve`) to stop through a file
 * in the factory's data folder, since they are other processes. A worker obeys a request written
 * after it started, so an old one never needs clearing.
 */
export interface StopRequest {
  /** When it was asked for, in ms since the epoch. */
  at: number;
  /** Interrupt running runs too, rather than letting them finish. */
  now: boolean;
}

export function stopFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(factoryDataDir(env), "stop.json");
}

export function requestStop(options: { now?: boolean } = {}, file = stopFilePath(), at = Date.now()): StopRequest {
  const request = { at, now: options.now === true };
  mkdirSync(dirname(file), { recursive: true });
  // A rename, so a worker reading it at the same moment sees the old request or the new one.
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ at: new Date(at).toISOString(), now: request.now })}\n`);
  renameSync(temp, file);
  return request;
}

/** The last stop request, or undefined when there is none or it can't be read. */
export function readStopRequest(file = stopFilePath()): StopRequest | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown; now?: unknown };
    const at = typeof data.at === "string" ? Date.parse(data.at) : NaN;
    // A file that doesn't say when is not a request: stopping every worker on garbage would be worse.
    return Number.isNaN(at) ? undefined : { at, now: data.now === true };
  } catch {
    return undefined;
  }
}
