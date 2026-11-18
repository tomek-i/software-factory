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
  pr: number | null;
  build: number;
  review: number;
  /** Times the merge stage went back to the builder because the default branch conflicted or broke the gate. */
  resyncs: number;
  cost: number;
  held: boolean;
  updatedAt: string;
  reason?: string;
  /** At a gate only the working stages before it; approve, reject and cancel are their own actions. */
  resumeTargets: RunState[];
  /** The loop cap that stopped it, e.g. "review round cap reached (3)". */
  capReached?: string;
  /** What it waits on that the builder could fix. */
  failure?: WaitingFailure;
  /** Its issue was closed on GitHub while its PR is open; cancelling closes the PR too. */
  issueClosed?: { pr: number };
}

/** One thing that failed. Written from agent output or GitHub: show it as text only. */
export interface FailureItem {
  name: string;
  summary?: string;
  link?: string;
  file?: string;
  line?: number;
}

export interface WaitingFailure {
  kind: "checks" | "quality_gate" | "findings" | "feedback";
  items: FailureItem[];
  /** The run file it comes from. */
  source?: string;
}

export interface CodeScanningAlert {
  number: number;
  rule: string;
  description: string;
  severity: string;
  tool: string;
  file?: string;
  line?: number;
  url: string;
}

/** The required checks that failed on a run's PR; a check with alerts is code scanning. */
export interface RunChecks {
  pr: number;
  failed: { name: string; link?: string; alerts: CodeScanningAlert[] }[];
  otherAlerts: CodeScanningAlert[];
}

/** GitHub's reasons for dismissing a code scanning alert. */
export const DISMISS_REASONS = ["false positive", "won't fix", "used in tests"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

export interface Dismissed {
  check: string;
  failing: string[];
  continued: boolean;
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
  | { kind: "capture"; path: string; summary: string[] }
  | { kind: "acceptance"; path: string; count: string; criteria: AcceptanceCriterion[] };

/** One acceptance criterion as the acceptance lens judged it. */
export interface AcceptanceCriterion {
  id: string;
  source: "issue" | "spec";
  text: string;
  status: "MET" | "NOT_MET" | "CANNOT_CHECK" | "NOT_CHECKED";
  evidence?: string;
}

/** One run in full. Its text comes from agents that read untrusted issues: show it as text only. */
export interface RunDetail {
  run: RunRow;
  issue: { number: number; title: string; url: string | null } | null;
  hasRunDir: boolean;
  files: string[];
  /** The files the page can't show, and why: no text (screenshots, videos), or too big. */
  unshown: Record<string, "binary" | "too_big">;
  sections: OverviewSection[];
  /** A finished run's worktree (relative to the repo) and branch cleanup has not removed, and why it kept them. */
  leftover?: { worktree: string; branch: string; kept?: string };
}

/** What a cleanup removed and kept (`lines`), and the runs it left alone with why. */
export interface CleanupResult {
  lines: string[];
  /** `recent`: left alone only because it just finished; cleaning up with `now` removes it. */
  skipped: { runId: string; why: string; recent: boolean }[];
}

/** One lens's review of the latest round; `problem` when its file does not parse. */
export type ReviewSummary = { lens: string; path: string; verdict: string; findings: number; blocking: number } | { lens: string; path: string; problem: string };

/** What a run at the merge gate is about to merge. Check names and links come from GitHub: show as text, link only http(s). */
export interface MergeGateDetails {
  pr: { number: number; url: string | null; head?: string; additions?: number; deletions?: number; changedFiles?: number } | null;
  checks: { passed: number; failed: number; pending: number; skipped: number; failedChecks: { name: string; link?: string }[] } | null;
  reviews: ReviewSummary[];
  rounds: { build: number; review: number };
  cost: number;
  githubError?: string;
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

/** One issue of an issue writer's draft. Written by an agent: show it as text only. */
export interface DraftIssue {
  title: string;
  ui: boolean;
  risk: "LOW" | "MEDIUM" | "HIGH";
  labels: string[];
  /** Sub-issues only: positions (1-based) of earlier sub-issues. */
  dependsOn: number[];
  body: string;
}

export interface IssueDraft {
  decision: "PROCEED" | "ESCALATE";
  summary: string[];
  reasons: string[];
  issue: DraftIssue;
  subIssues: DraftIssue[];
}

/** A draft not created on GitHub yet. */
export interface DraftView {
  project: string;
  projectName: string;
  id: string;
  idea: string;
  createdAt: string;
  /** The issue writer is still writing it. */
  running: boolean;
  /** Null when it does not parse (see problems) or is still being written. */
  draft: IssueDraft | null;
  problems: string[];
  /** Why it may never be created (git tracks it). */
  refusal: string | null;
  /** Issues already created from it. */
  created: number[];
}

export interface CreatedIssue {
  number: number;
  title: string;
  url: string | null;
}

export interface PublishedDraft {
  issue: CreatedIssue;
  subIssues: CreatedIssue[];
  buildable: number[];
  queued: number[];
}

/** How the issue writer the page started ended. */
export type DraftResult = { kind: "published"; published: PublishedDraft } | { kind: "waiting"; reasons: string[] } | { kind: "failed"; error: string };

/** The issue writer's progress, as a run's (`activityLine` reads both). */
export type AgentEvent = Extract<ServerEvent, { type: "run" }>["event"];

export interface DraftDetail {
  project: string;
  projectName: string;
  id: string;
  /** Null once created or discarded. */
  pending: (DraftView & { text: string | null }) | null;
  /** The issue writer `factory serve` started for it, if any. */
  job: { running: boolean; events: AgentEvent[]; result?: DraftResult } | null;
}

/** The editor's fields; the server validates them as `factory new --approve` does. */
export interface DraftEdit {
  issue: { title: string; ui: boolean; risk: string; body: string; labels: string[] };
  subIssues: { title: string; ui: boolean; risk: string; body: string; labels: string[]; dependsOn: number[] }[];
}

/** What the event stream sends: the scheduler's events, and "changed" after an action. */
export type ServerEvent =
  | { type: "changed"; project?: string }
  | { type: "draft"; project: string; draftId: string; event: AgentEvent }
  | { type: "draft:done"; project: string; draftId: string; result: DraftResult }
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
export type SettingKind =
  | { type: "boolean" }
  | { type: "integer"; min: number; max?: number }
  | { type: "number" }
  | { type: "enum"; options: string[] }
  | { type: "string" }
  | { type: "list"; options?: string[] }
  | { type: "checks" }
  | { type: "models"; keys: string[] };

/** One setting of `.factory/config.yaml`, as the default branch has it. */
export interface SettingView {
  path: string;
  section: string;
  label: string;
  help: string;
  kind: SettingKind;
  /** What a change to it can let through without you. */
  sensitive?: string;
  /** Why it can't be changed here. */
  readOnly?: string;
  /** What the file sets; absent when it leaves the setting to the default. */
  value?: unknown;
  effective?: unknown;
  default?: unknown;
}

export interface ProjectSettings {
  branch: string;
  /** The commit they were read at; a save names it, so it can't overwrite a newer change. */
  head: string;
  sections: { key: string; title: string; about: string }[];
  settings: SettingView[];
  builtinPaths: string[];
  problems: string[];
}

export type SettingChange = { path: string; value: unknown } | { path: string; reset: true };

export interface SavedSettings {
  commit: string;
  branch: string;
  changed: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: object): Promise<T> {
  const headers: Record<string, string> = { [TOKEN_HEADER]: sessionToken() ?? "" };
  const sends = method !== "GET";
  if (sends) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: sends ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

// The project key can come from the page's URL, so every path encodes it, as it does a run id.
const projectPath = (project: string) => `/api/projects/${encodeURIComponent(project)}`;
const runPath = (run: Pick<RunRow, "project" | "id">, action: string) => `${projectPath(run.project)}/runs/${encodeURIComponent(run.id)}/${action}`;
const draftPath = (project: string, id: string, action?: string) =>
  `${projectPath(project)}/drafts/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
// What the page showed, so the server refuses a decision about a run that has moved on since.
const shown = (run: RunRow) => ({ state: run.state, gate: run.waitingGate ?? undefined });

export const api = {
  projects: () => request<ProjectInfo[]>("GET", "/api/projects"),
  scheduler: () => request<SchedulerStatus | null>("GET", "/api/scheduler"),
  runs: (view: RunView, project?: string) =>
    request<RunRow[]>("GET", `/api/runs?view=${view}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
  run: (project: string, id: string) => request<RunDetail>("GET", `${projectPath(project)}/runs/${encodeURIComponent(id)}`),
  mergeGate: (run: Pick<RunRow, "project" | "id">) => request<MergeGateDetails>("GET", runPath(run, "merge-gate")),
  runFile: (project: string, id: string, path: string) =>
    request<RunFile>("GET", runPath({ project, id }, `files/${path.split("/").map(encodeURIComponent).join("/")}`)),
  backlog: (project: string) => request<Backlog>("GET", `${projectPath(project)}/issues`),
  sync: (project: string) => request<SyncResult>("POST", `${projectPath(project)}/sync`),
  queue: (project: string, issue: number, queued: boolean) => request<object>("POST", `${projectPath(project)}/issues/${issue}/${queued ? "queue" : "unqueue"}`),
  approve: (run: RunRow, message?: string) => request<object>("POST", runPath(run, "approve"), { ...shown(run), message }),
  reject: (run: RunRow, message: string) => request<object>("POST", runPath(run, "reject"), { ...shown(run), message }),
  resume: (run: RunRow, to: RunState, message: string, resetLoops: boolean) =>
    request<object>("POST", runPath(run, "resume"), { ...shown(run), to, message, resetLoops }),
  checks: (run: Pick<RunRow, "project" | "id">) => request<RunChecks>("GET", runPath(run, "checks")),
  dismiss: (run: RunRow, alert: number, reason: DismissReason, comment: string) =>
    request<Dismissed>("POST", runPath(run, "dismiss"), { ...shown(run), alert, reason, comment }),
  cancel: (run: RunRow, message?: string) => request<object>("POST", runPath(run, "cancel"), { ...shown(run), message }),
  cleanupRun: (run: RunRow) => request<{ lines: string[] }>("POST", runPath(run, "cleanup"), shown(run)),
  cleanup: (project: string, now: boolean) => request<CleanupResult>("POST", `/api/projects/${project}/cleanup`, { now }),
  drafts: (project?: string) => request<DraftView[]>("GET", `/api/drafts${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  draft: (project: string, id: string) => request<DraftDetail>("GET", draftPath(project, id)),
  startDraft: (project: string, idea: string, queue: boolean) => request<{ id: string; ignored: string[] }>("POST", `${projectPath(project)}/drafts`, { idea, queue }),
  saveDraft: (project: string, id: string, edit: DraftEdit) => request<DraftView>("POST", draftPath(project, id, "save"), edit),
  publishDraft: (project: string, id: string, queue: boolean) => request<PublishedDraft>("POST", draftPath(project, id, "publish"), { queue }),
  discardDraft: (project: string, id: string) => request<{ id: string; created: number[] }>("POST", draftPath(project, id, "discard")),
  stopDraft: (project: string, id: string) => request<object>("POST", draftPath(project, id, "stop")),
  settings: (project: string) => request<ProjectSettings>("GET", `${projectPath(project)}/settings`),
  saveSettings: (project: string, head: string, changes: SettingChange[]) => request<SavedSettings>("PUT", `${projectPath(project)}/settings`, { head, changes }),
};
