import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { Gate, GateMode, RunState } from "@factory/shared";
import { MIGRATIONS } from "./migrations.js";

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  github_repo: string | null;
  created_at: string;
}

export interface Run {
  id: string;
  project_id: string;
  issue_number: number | null;
  title: string;
  state: RunState;
  unsafe: boolean;
  branch: string | null;
  worktree_path: string | null;
  pr_number: number | null;
  build_iterations: number;
  review_rounds: number;
  critic_rounds: number;
  waiting_gate: Gate | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunEvent {
  id: number;
  run_id: string;
  from_state: RunState | null;
  to_state: RunState;
  reason: string;
  data: unknown;
  created_at: string;
}

export type DecisionOutcome = "proceed" | "escalate" | "approve" | "reject";
export type DecisionActor = "agent" | "human" | "system";

export interface Decision {
  id: number;
  run_id: string;
  gate: Gate;
  mode: GateMode;
  outcome: DecisionOutcome;
  actor: DecisionActor;
  comment: string;
  commit_sha: string | null;
  created_at: string;
}

/** Fields the state machine may change alongside a state transition. */
export type RunPatch = Partial<
  Pick<
    Run,
    | "branch"
    | "worktree_path"
    | "pr_number"
    | "build_iterations"
    | "review_rounds"
    | "critic_rounds"
    | "waiting_gate"
    | "title"
  >
>;

type RunRow = Omit<Run, "unsafe"> & { unsafe: number };

const now = () => new Date().toISOString();

function toRun(row: RunRow | undefined): Run | undefined {
  return row && { ...row, unsafe: row.unsafe === 1 };
}

/**
 * SQLite-backed store shared by CLI mode (one project, db in the repo) and
 * web mode (many projects, db in the user's home directory).
 */
export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(
      this.db
        .prepare("SELECT version FROM schema_migrations")
        .all()
        .map((r) => (r as { version: number }).version),
    );
    MIGRATIONS.forEach((sql, index) => {
      const version = index + 1;
      if (applied.has(version)) return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now());
      })();
    });
  }

  /** Run fn atomically; nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- projects -----------------------------------------------------------

  upsertProject(input: { name: string; repo_path: string; github_repo?: string | null }): Project {
    const existing = this.db.prepare("SELECT * FROM projects WHERE repo_path = ?").get(input.repo_path) as
      | Project
      | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE projects SET name = ?, github_repo = ? WHERE id = ?")
        .run(input.name, input.github_repo ?? existing.github_repo, existing.id);
      return this.getProject(existing.id)!;
    }
    const project: Project = {
      id: randomUUID(),
      name: input.name,
      repo_path: input.repo_path,
      github_repo: input.github_repo ?? null,
      created_at: now(),
    };
    this.db
      .prepare("INSERT INTO projects (id, name, repo_path, github_repo, created_at) VALUES (@id, @name, @repo_path, @github_repo, @created_at)")
      .run(project);
    return project;
  }

  getProject(id: string): Project | undefined {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects ORDER BY name").all() as Project[];
  }

  // ---- runs ---------------------------------------------------------------

  createRun(input: { project_id: string; title: string; issue_number?: number | null; unsafe?: boolean }): Run {
    const ts = now();
    const id = `run-${input.issue_number ?? "new"}-${randomUUID().slice(0, 8)}`;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO runs (id, project_id, issue_number, title, state, unsafe, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'intake', ?, ?, ?)`,
        )
        .run(id, input.project_id, input.issue_number ?? null, input.title, input.unsafe ? 1 : 0, ts, ts);
      this.appendEvent(id, null, "intake", "run created", { unsafe: !!input.unsafe });
    });
    return this.getRun(id)!;
  }

  getRun(id: string): Run | undefined {
    return toRun(this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined);
  }

  listRuns(filter: { project_id?: string; states?: RunState[] } = {}): Run[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.project_id) {
      where.push("project_id = ?");
      params.push(filter.project_id);
    }
    if (filter.states?.length) {
      where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      params.push(...filter.states);
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as RunRow[]).map((r) => toRun(r)!);
  }

  /** Low-level write used only by the state machine. Does not validate the transition. */
  writeState(id: string, state: RunState, patch: RunPatch = {}): void {
    const fields = Object.keys(patch) as (keyof RunPatch)[];
    const sets = ["state = @state", "updated_at = @updated_at", ...fields.map((f) => `${f} = @${f}`)];
    this.db
      .prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = @id`)
      .run({ ...patch, id, state, updated_at: now() });
  }

  // ---- leases -------------------------------------------------------------

  /**
   * Atomically claim a run for a worker. Succeeds if the run is unleased,
   * the lease expired, or the same owner already holds it (renewal).
   */
  acquireLease(runId: string, owner: string, ttlMs: number): boolean {
    const ts = new Date();
    const result = this.db
      .prepare(
        `UPDATE runs SET lease_owner = ?, lease_expires_at = ?
         WHERE id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at < ?)`,
      )
      .run(owner, new Date(ts.getTime() + ttlMs).toISOString(), runId, owner, ts.toISOString());
    return result.changes === 1;
  }

  releaseLease(runId: string, owner: string): void {
    this.db
      .prepare("UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?")
      .run(runId, owner);
  }

  // ---- events & decisions -------------------------------------------------

  appendEvent(runId: string, from: RunState | null, to: RunState, reason: string, data?: unknown): void {
    this.db
      .prepare("INSERT INTO run_events (run_id, from_state, to_state, reason, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, from, to, reason, data === undefined ? null : JSON.stringify(data), now());
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY id").all(runId) as (Omit<
      RunEvent,
      "data"
    > & { data: string | null })[];
    return rows.map((r) => ({ ...r, data: r.data === null ? null : JSON.parse(r.data) }));
  }

  recordDecision(input: Omit<Decision, "id" | "created_at" | "commit_sha"> & { commit_sha?: string | null }): void {
    if (!input.comment.trim()) throw new Error("a decision needs a comment explaining it");
    this.db
      .prepare(
        `INSERT INTO decisions (run_id, gate, mode, outcome, actor, comment, commit_sha, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.run_id, input.gate, input.mode, input.outcome, input.actor, input.comment, input.commit_sha ?? null, now());
  }

  listDecisions(runId: string): Decision[] {
    return this.db.prepare("SELECT * FROM decisions WHERE run_id = ? ORDER BY id").all(runId) as Decision[];
  }
}
