import type { SchedulerStatus, StartLimit } from "./api";

/** A project the scheduler's start limit holds back, as its status reports it. */
export type Limited = NonNullable<SchedulerStatus["limited"]>[number];

/** The time only when it is today, else with its date. */
function when(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${time} on ${at.toLocaleDateString()}`;
}

/** Why queued issues are not starting, worded as `factory status` words it. */
export function startLimitText(limit: StartLimit, now = new Date()): string {
  if (limit.max === 0) return "Start limit: github.max_starts_per_day is 0, so no queued issue starts until it is raised.";
  const runs = `${limit.started} run${limit.started === 1 ? "" : "s"}`;
  const next = limit.nextStartAt ? ` The next queued issue can start at ${when(limit.nextStartAt, now)}.` : "";
  return `Start limit reached: ${runs} started in the last 24 h (github.max_starts_per_day).${next}`;
}

export const limitOf = (held: Limited): StartLimit => ({ started: held.started, max: held.max, ...(held.until ? { nextStartAt: held.until } : {}) });

/**
 * The header's short note while the start limit holds any queue back: when the first held project
 * can start again, or that none can start (a limit of 0). `label` says it in full, per project.
 */
export function startLimitNote(limited: Limited[], now = new Date()): { text: string; label: string } | undefined {
  if (limited.length === 0) return undefined;
  const times = limited.flatMap((l) => (l.until ? [l.until] : [])).sort();
  const text = times.length ? `start limit until ${when(times[0]!, now)}` : "start limit: none start";
  const label = limited
    .map((l) => (l.until ? `Start limit reached for ${l.project}: the next queued issue can start at ${when(l.until, now)}.` : `Start limit for ${l.project}: github.max_starts_per_day is 0.`))
    .join(" ");
  return { text, label };
}
