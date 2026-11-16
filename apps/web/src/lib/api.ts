import type { Gate, RunState } from "@factory/shared";
import { sessionToken, TOKEN_HEADER } from "./session";

/** The shapes `apps/server` sends. Kept here rather than imported, so the app needs nothing from Node. */

export interface ProjectInfo {
  key: string;
  name: string;
  path: string;
  status: "ok" | "missing_repo" | "missing_db" | "error";
  problem?: string;
}

export interface BacklogIssue {
  number: number;
  title: string;
  author: string;
  url: string;
  labels: string[];
  queued: boolean;
  position: number | null;
  trusted: boolean;
  run: { id: string; state: RunState; waitingGate: Gate | null } | null;
}

export interface Backlog {
  github: string | null;
  syncedAt: string | null;
  issues: BacklogIssue[];
}

export interface SyncResult {
  open: number;
  closed: number;
  queued: number;
  lines: string[];
}

export interface RunRow {
  project: string;
  projectName: string;
  id: string;
  issue: number | null;
  title: string;
  state: RunState;
  waitingGate: Gate | null;
  build: number;
  review: number;
  cost: number;
  held: boolean;
  updatedAt: string;
  reason?: string;
  resumeTargets: RunState[];
}

/** A finding a review or the verifier said blocks the run. */
export interface Finding {
  id: string;
  severity: "critical" | "major" | "minor" | "nit";
  file?: string;
  line?: number;
  claim: string;
  evidence: string;
}

/** One section of a run's overview, about one file of its run folder (as `factory show` prints them). */
export type OverviewSection =
  | { kind: "verdict"; path: string; key: string; value: string; summary: string[]; blocking: Finding[]; refuted: number }
  | { kind: "unparsed"; path: string; problem: string }
  | { kind: "capture"; path: string; summary: string[] };

/** One run in full. Its text comes from agents that read untrusted issues: show it as text only. */
export interface RunDetail {
  run: RunRow;
  issue: { number: number; title: string; url: string | null } | null;
  hasRunDir: boolean;
  files: string[];
  sections: OverviewSection[];
}

export interface RunFile {
  path: string;
  text: string;
}

export interface SchedulerStatus {
  running: { project: string; issue: number; runId?: string }[];
  pausedUntil?: string;
  stopping?: "drain" | "now";
}

export type RunView = "active" | "waiting" | "all";

/** What the event stream sends: the scheduler's events, and "changed" after an action. */
export type ServerEvent =
  | { type: "changed"; project?: string }
  | { type: "run"; project: string; issue: number; event: { type: string; runId: string; summary?: string; role?: string; to?: RunState; reason?: string; message?: string } }
  | { type: "started" | "finished"; project: string; issue: number; run: { id: string; state: RunState } }
  | { type: "failed"; project: string; issue: number; error: string }
  | { type: "skipped"; project: string; issue?: number; reason: string }
  | { type: "notice"; project: string; issue: number; message: string }
  | { type: "error"; message: string }
  | { type: "paused"; until: string }
  | { type: "resumed" }
  | { type: "stopping"; now: boolean; interrupted: number };

/** An error the server explained, or no session. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: sessionToken() ?? "" };
  if (method === "POST") headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

const runPath = (run: Pick<RunRow, "project" | "id">, action: string) => `/api/projects/${run.project}/runs/${encodeURIComponent(run.id)}/${action}`;
// What the page showed, so the server refuses a decision about a run that has moved on since.
const shown = (run: RunRow) => ({ state: run.state, gate: run.waitingGate ?? undefined });

export const api = {
  projects: () => request<ProjectInfo[]>("GET", "/api/projects"),
  scheduler: () => request<SchedulerStatus | null>("GET", "/api/scheduler"),
  runs: (view: RunView, project?: string) =>
    request<RunRow[]>("GET", `/api/runs?view=${view}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  run: (project: string, id: string) => request<RunDetail>("GET", `/api/projects/${project}/runs/${encodeURIComponent(id)}`),
  runFile: (project: string, id: string, path: string) =>
    request<RunFile>("GET", runPath({ project, id }, `files/${path.split("/").map(encodeURIComponent).join("/")}`)),
  backlog: (project: string) => request<Backlog>("GET", `/api/projects/${project}/issues`),
  sync: (project: string) => request<SyncResult>("POST", `/api/projects/${project}/sync`),
  queue: (project: string, issue: number, queued: boolean) => request<object>("POST", `/api/projects/${project}/issues/${issue}/${queued ? "queue" : "unqueue"}`),
  approve: (run: RunRow, message?: string) => request<object>("POST", runPath(run, "approve"), { ...shown(run), message }),
  reject: (run: RunRow, message: string) => request<object>("POST", runPath(run, "reject"), { ...shown(run), message }),
  resume: (run: RunRow, to: RunState, message: string) => request<object>("POST", runPath(run, "resume"), { ...shown(run), to, message }),
  cancel: (run: RunRow, message?: string) => request<object>("POST", runPath(run, "cancel"), { ...shown(run), message }),
};
