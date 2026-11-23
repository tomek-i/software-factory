import type { StartLimit } from "@factory/core";

const pad = (n: number) => String(n).padStart(2, "0");

/** A local time, with the date when it isn't today. */
export function localTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (at.toDateString() === new Date(now).toDateString()) return time;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** Why queued issues are not starting: the project's `github.max_starts_per_day`, and when it lifts. */
export function startLimitLine(limit: StartLimit, now: number = Date.now()): string {
  if (limit.max === 0) return "Start limit: github.max_starts_per_day is 0, so no queued issue starts until it is raised.";
  const runs = `${limit.started} run${limit.started === 1 ? "" : "s"}`;
  const next = limit.nextStartAt ? ` The next queued issue can start at ${localTime(limit.nextStartAt, now)}.` : "";
  return `Start limit reached: ${runs} started in the last 24 h (github.max_starts_per_day).${next}`;
}
