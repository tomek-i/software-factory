import { z } from "zod";
import { GATE_MODES, GATES, RUN_STATES, TERMINAL_STATES } from "./states.js";

/**
 * The file `factory export` writes and `factory import` reads: one project's local state, so it can
 * move between machines. Importing it sets trust markers (`queued_at`, `created_by_factory`), so
 * every row is checked here before anything is written. Unknown keys are dropped, never written:
 * the columns an import writes are named by the code, not by the file.
 *
 * A column a later migration adds goes in as `.optional()` with a default, so files from older
 * factories keep importing.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

const timestamp = z.iso.datetime({ offset: true });
const int = z.number().int();
const count = int.nonnegative();
/** Run ids also name folders (`.factory/runs/<id>`, worktrees), so nothing that could leave one. */
const runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/, "not a run id");
const jsonText = z.string().refine((text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}, "not JSON");

export const snapshotHeaderSchema = z.object({
  format_version: int.positive(),
  /** How many store migrations the exporting factory had applied. */
  schema_version: int.positive(),
  exported_at: timestamp,
  host: z.string(),
  github_repo: z.string().min(1),
});

export const snapshotIssueSchema = z.object({
  number: int.positive(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed"]),
  author: z.string(),
  labels: z.array(z.string()),
  url: z.string(),
  gh_updated_at: timestamp,
  synced_at: timestamp,
  queued_at: timestamp.nullable(),
  queue_seq: int.nullable(),
  created_by_factory: z.boolean(),
});

/** Only finished runs travel: an active one's worktree, branch and agent session stay on its machine. */
export const snapshotRunSchema = z.object({
  id: runId,
  issue_number: int.positive().nullable(),
  title: z.string(),
  state: z.enum(TERMINAL_STATES),
  unsafe: z.boolean(),
  /** Never an option to git: it cannot start with a dash. */
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "not a branch name").nullable(),
  pr_number: int.positive().nullable(),
  build_iterations: count,
  review_rounds: count,
  critic_rounds: count,
  round: count,
  waiting_gate: z.enum(GATES).nullable(),
  parked_from: z.enum(RUN_STATES).nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const snapshotRunEventSchema = z.object({
  run_id: runId,
  from_state: z.enum(RUN_STATES).nullable(),
  to_state: z.enum(RUN_STATES),
  reason: z.string(),
  /** Kept as the JSON text the store holds. */
  data: jsonText.nullable(),
  created_at: timestamp,
});

export const snapshotDecisionSchema = z.object({
  run_id: runId,
  gate: z.enum([...GATES, "escalation"]),
  mode: z.enum(GATE_MODES),
  outcome: z.enum(["proceed", "escalate", "approve", "reject"]),
  actor: z.enum(["agent", "human", "system"]),
  comment: z.string(),
  commit_sha: z.string().nullable(),
  created_at: timestamp,
});

export const snapshotAgentRunSchema = z.object({
  id: z.string().regex(/^agent-[0-9a-f]{8}$/, "not an agent run id"),
  run_id: runId,
  role: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  session_id: z.string().nullable(),
  status: z.enum(["running", "ok", "error", "rate_limited", "cancelled"]),
  cost_usd: z.number().nonnegative().nullable(),
  input_tokens: count.nullable(),
  output_tokens: count.nullable(),
  excerpt: z.string().nullable(),
  started_at: timestamp,
  ended_at: timestamp.nullable(),
});

export const snapshotLessonSchema = z.object({
  run_id: runId,
  status: z.enum(["proposed", "approved", "rejected"]),
  observation: z.string(),
  evidence: z.string(),
  rule: z.string(),
  comment: z.string().nullable(),
  pull_request: int.positive().nullable(),
  created_at: timestamp,
  decided_at: timestamp.nullable(),
});

/** Draft ids also name folders (`.factory/drafts/<id>`). */
const draftId = z.string().regex(/^draft-[A-Za-z0-9-]{1,64}$/, "not a draft id");

export const snapshotDraftIssueSchema = z.object({
  draft_id: draftId,
  position: count,
  number: int.positive(),
  fingerprint: z.string(),
  linked: z.boolean(),
});

export const snapshotDraftDoneSchema = z.object({
  draft_id: draftId,
  done_at: timestamp,
});

export const snapshotSchema = z.object({
  header: snapshotHeaderSchema,
  issues: z.array(snapshotIssueSchema),
  runs: z.array(snapshotRunSchema),
  run_events: z.array(snapshotRunEventSchema),
  decisions: z.array(snapshotDecisionSchema),
  agent_runs: z.array(snapshotAgentRunSchema),
  lessons: z.array(snapshotLessonSchema),
  draft_issues: z.array(snapshotDraftIssueSchema),
  drafts_done: z.array(snapshotDraftDoneSchema),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotHeader = z.infer<typeof snapshotHeaderSchema>;
export type SnapshotIssue = z.infer<typeof snapshotIssueSchema>;
export type SnapshotRun = z.infer<typeof snapshotRunSchema>;
export type SnapshotLesson = z.infer<typeof snapshotLessonSchema>;
