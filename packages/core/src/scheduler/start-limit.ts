import { isTerminal } from "@factory/shared";
import type { Issue, Store } from "../store/store.js";

const DAY_MS = 24 * 60 * 60_000;

/** Where a project stands against `github.max_starts_per_day`. */
export interface StartLimit {
  /** New runs in the last 24 hours, by anyone. Cancelled and rejected ones count: they were started. */
  started: number;
  max: number;
  /**
   * At the limit: when the next new run may start, once enough runs are 24 hours old. Unset with
   * `max` 0, which starts nothing until the setting changes.
   */
  nextStartAt?: string;
}

/**
 * The rolling 24-hour window the scheduler starts new runs within, shared with the front ends that
 * say why queued issues are waiting. A run counts for exactly 24 hours after it was created.
 */
export function startLimit(store: Store, projectId: string, max: number, now: number): StartLimit {
  const since = new Date(now - DAY_MS).toISOString();
  const window = store
    .listRuns({ project_id: projectId })
    .map((r) => r.created_at)
    .filter((created) => created > since)
    .sort();
  const started = window.length;
  if (started < max || max === 0) return { started, max };
  // With the limit lowered below what already started, more than the oldest one must age out.
  return { started, max, nextStartAt: new Date(Date.parse(window[started - max]!) + DAY_MS).toISOString() };
}

export function atStartLimit(limit: StartLimit): boolean {
  return limit.started >= limit.max;
}

/**
 * Queued open issues waiting for a new run, in the order the scheduler starts them. An issue whose
 * run is going on, or that already had its run since it was queued, isn't waiting to start.
 */
export function waitingToStart(store: Store, projectId: string): Issue[] {
  const runs = store.listRuns({ project_id: projectId });
  return store
    .listIssues({ project_id: projectId, state: "open", queued: true })
    .filter((i) => !runs.some((r) => r.issue_number === i.number && (r.created_at >= i.queued_at! || !isTerminal(r.state))))
    .sort((a, b) => (a.queued_at! < b.queued_at! ? -1 : a.queued_at! > b.queued_at! ? 1 : (a.queue_seq ?? 0) - (b.queue_seq ?? 0)));
}

/** The start limit when it is what keeps queued issues from starting, for a front end to say so. */
export function heldStartLimit(store: Store, projectId: string, max: number, now: number): StartLimit | undefined {
  const limit = startLimit(store, projectId, max, now);
  return atStartLimit(limit) && waitingToStart(store, projectId).length > 0 ? limit : undefined;
}
