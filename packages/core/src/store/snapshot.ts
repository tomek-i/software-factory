import { hostname } from "node:os";
import {
  isTerminal,
  SNAPSHOT_FORMAT_VERSION,
  snapshotHeaderSchema,
  snapshotSchema,
  type RunState,
  type Snapshot,
  type SnapshotHeader,
  type SnapshotIssue,
  type SnapshotLesson,
} from "@factory/shared";
import { ServiceError } from "../service/errors.js";
import { FACTORY_CLAIM_PENDING, NEVER_SYNCED, type Project, type StoredLesson, type Store } from "./store.js";

/**
 * `factory export` / `factory import`: move one project's local state (the queue, trust markers,
 * finished runs, lessons, draft progress) between machines as JSON. The store is gitignored and
 * `factory sync` only rebuilds the GitHub side, so this is the only way that state travels.
 *
 * What stays behind: paths and process data that only mean something on the machine that wrote
 * them, and runs that are not finished (their worktree, branch and agent session live there).
 */

/** How many store migrations are applied, which `MIGRATIONS.length` equals once the store is open. */
export function schemaVersion(store: Store): number {
  const row = store.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

export interface ExportResult {
  snapshot: Snapshot;
  /** Runs that were left out because they are not finished. */
  skipped: string[];
  /**
   * Queued issues exported without their queue time because a run left out is still working on
   * them here: queued there, the other machine would start a second run of the same issue.
   */
  unqueued: number[];
}

/** Read the project's state in one transaction, so a run moving meanwhile cannot tear the snapshot. */
export function exportSnapshot(store: Store, project: Project, options: { now?: Date; host?: string } = {}): ExportResult {
  const githubRepo = project.github_repo;
  if (!githubRepo) throw new ServiceError(NO_GITHUB_REPO);
  return store.transaction(() => {
    const db = store.db;
    // Columns are listed so the machine-local ones (paths, ports, leases, pids, logs) never leave.
    const runs = db
      .prepare(
        `SELECT id, issue_number, title, state, unsafe, branch, pr_number, build_iterations, review_rounds, critic_rounds,
                resync_rounds, round, waiting_gate, parked_from, created_at, updated_at
         FROM runs WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(project.id) as (Omit<Snapshot["runs"][number], "unsafe" | "state"> & { state: RunState; unsafe: number })[];
    const finished = runs.filter((r) => isTerminal(r.state));
    const active = runs.filter((r) => !isTerminal(r.state));
    const skipped = active.map((r) => r.id);
    const busy = new Set(active.map((r) => r.issue_number));
    const unqueued: number[] = [];
    const exported = new Set(finished.map((r) => r.id));
    const ofExported = <T extends { run_id: string }>(rows: unknown[]) => (rows as T[]).filter((r) => exported.has(r.run_id));
    const byRun = (columns: string, table: string, order: string) =>
      db
        .prepare(`SELECT ${columns} FROM ${table} t JOIN runs r ON r.id = t.run_id WHERE r.project_id = ? ORDER BY ${order}`)
        .all(project.id);

    const snapshot: Snapshot = {
      header: {
        format_version: SNAPSHOT_FORMAT_VERSION,
        schema_version: schemaVersion(store),
        exported_at: (options.now ?? new Date()).toISOString(),
        host: options.host ?? hostname(),
        github_repo: githubRepo,
      },
      issues: (
        db
          .prepare(
            `SELECT number, title, body, state, author, labels, url, gh_updated_at, synced_at, queued_at, queue_seq, created_by_factory
             FROM issues WHERE project_id = ? ORDER BY number`,
          )
          .all(project.id) as (Omit<SnapshotIssue, "labels" | "created_by_factory"> & { labels: string; created_by_factory: number })[]
      ).map((i) => {
        const issue = { ...i, labels: JSON.parse(i.labels) as string[], created_by_factory: i.created_by_factory === 1 };
        if (issue.queued_at === null || issue.state !== "open" || !busy.has(issue.number)) return issue;
        unqueued.push(issue.number);
        return { ...issue, queued_at: null, queue_seq: null };
      }),
      runs: finished.map((r) => ({ ...r, state: r.state as Snapshot["runs"][number]["state"], unsafe: r.unsafe === 1 })),
      run_events: ofExported(byRun("t.run_id, t.from_state, t.to_state, t.reason, t.data, t.created_at", "run_events", "t.id")),
      decisions: ofExported(byRun("t.run_id, t.gate, t.mode, t.outcome, t.actor, t.comment, t.commit_sha, t.created_at", "decisions", "t.id")),
      agent_runs: ofExported(
        byRun(
          `t.id, t.run_id, t.role, t.model, t.effort, t.session_id, t.status, t.cost_usd, t.input_tokens, t.output_tokens,
           t.excerpt, t.started_at, t.ended_at`,
          "agent_runs",
          "t.started_at, t.rowid",
        ),
      ),
      lessons: ofExported(
        db
          .prepare(
            `SELECT run_id, status, observation, evidence, rule, comment, pull_request, created_at, decided_at
             FROM lessons WHERE project_id = ? ORDER BY id`,
          )
          .all(project.id),
      ),
      draft_issues: (
        db
          .prepare("SELECT draft_id, position, number, fingerprint, linked FROM draft_issues WHERE project_id = ? ORDER BY draft_id, position")
          .all(project.id) as (Omit<Snapshot["draft_issues"][number], "linked"> & { linked: number })[]
      ).map((d) => ({ ...d, linked: d.linked === 1 })),
      drafts_done: db.prepare("SELECT draft_id, done_at FROM drafts_done WHERE project_id = ? ORDER BY draft_id").all(project.id) as Snapshot["drafts_done"],
    };
    return { snapshot, skipped, unqueued };
  });
}

/** What an import added or changed, or would have with `dryRun`. */
export interface ImportReport {
  header: SnapshotHeader;
  dryRun: boolean;
  runs: { added: string[]; /** Already in this store, so left as they are. */ present: number };
  run_events: number;
  decisions: number;
  agent_runs: number;
  /** Agent runs whose id this store already has under another run; skipped. */
  agent_run_conflicts: string[];
  issues: {
    /** Queued or factory-made issues this store did not have yet; `factory sync` fills them in. */
    added: number[];
    /** Existing issues the snapshot queued, or queued again later. */
    queued: number[];
    /** Existing issues the snapshot says the factory opened: a claim the next fetch from GitHub settles. */
    created_by_factory: number[];
  };
  lessons: {
    added: number;
    /** Proposed here and decided in the snapshot, or decided on both with the snapshot's decision the later one. */
    decided: number;
    /** Their run is not in this store (it was still active where they were exported). */
    missing_run: number;
  };
  draft_issues: number;
  drafts_done: number;
}

/** How many rows an import added or changed; 0 means the store already had everything. */
export function importChangeCount(report: ImportReport): number {
  return (
    report.runs.added.length +
    report.run_events +
    report.decisions +
    report.agent_runs +
    report.issues.added.length +
    report.issues.queued.length +
    report.issues.created_by_factory.length +
    report.lessons.added +
    report.lessons.decided +
    report.draft_issues +
    report.drafts_done
  );
}

const NO_GITHUB_REPO =
  "This project has no GitHub repository, and snapshots are matched to projects by it. Add an `origin` remote on GitHub and run `factory init` again.";

/** Thrown inside the import transaction to roll a dry run back after it ran the real merge. */
class DryRunRollback extends Error {}

/**
 * Merge a snapshot into the store; never replaces anything wholesale. The whole file is checked
 * first, and the merge runs in one transaction, so an import that fails changes nothing.
 * `input` is the parsed JSON, untrusted until checked here.
 */
export function importSnapshot(store: Store, project: Project, input: unknown, options: { dryRun?: boolean } = {}): ImportReport {
  const snapshot = validateSnapshot(store, project, input);
  const report: ImportReport = {
    header: snapshot.header,
    dryRun: !!options.dryRun,
    runs: { added: [], present: 0 },
    run_events: 0,
    decisions: 0,
    agent_runs: 0,
    agent_run_conflicts: [],
    issues: { added: [], queued: [], created_by_factory: [] },
    lessons: { added: 0, decided: 0, missing_run: 0 },
    draft_issues: 0,
    drafts_done: 0,
  };
  try {
    store.transaction(() => {
      mergeRuns(store, project, snapshot, report);
      mergeIssues(store, project, snapshot.issues, report);
      mergeLessons(store, project, snapshot.lessons, report);
      mergeDrafts(store, project, snapshot, report);
      if (options.dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  return report;
}

function validateSnapshot(store: Store, project: Project, input: unknown): Snapshot {
  if (typeof input !== "object" || input === null || !("header" in input)) throw new ServiceError("This is not a factory snapshot: it has no header.");
  const header = snapshotHeaderSchema.safeParse(input.header);
  if (!header.success) throw new ServiceError(`This is not a factory snapshot: ${describeIssue(header.error.issues[0], ["header"])}.`);
  const { format_version, schema_version, github_repo } = header.data;
  if (format_version > SNAPSHOT_FORMAT_VERSION) {
    throw new ServiceError(`The snapshot was written by a newer factory (format ${format_version}, this one reads ${SNAPSHOT_FORMAT_VERSION}). Upgrade the factory on this machine, then import again.`);
  }
  if (format_version !== SNAPSHOT_FORMAT_VERSION) throw new ServiceError(`Snapshot format ${format_version} is not supported.`);
  const local = schemaVersion(store);
  if (schema_version > local) {
    throw new ServiceError(`The snapshot was exported by a newer factory (database schema ${schema_version}, this one has ${local}). Upgrade the factory on this machine, then import again.`);
  }
  if (!project.github_repo) throw new ServiceError(NO_GITHUB_REPO);
  if (github_repo.toLowerCase() !== project.github_repo.toLowerCase()) {
    throw new ServiceError(`The snapshot is of ${github_repo}, but this repository is ${project.github_repo}. Import it in a clone of ${github_repo}.`);
  }
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) throw new ServiceError(`The snapshot is damaged, nothing was imported: ${describeIssue(parsed.error.issues[0])}.`);
  return parsed.data;
}

function describeIssue(issue: { path: PropertyKey[]; message: string } | undefined, prefix: PropertyKey[] = []): string {
  if (!issue) return "unreadable";
  const path = [...prefix, ...issue.path].map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Runs are keyed by id: one this store lacks is added with its events, decisions and agent runs;
 * one it has is left alone, children included. Machine-local columns start empty.
 */
function mergeRuns(store: Store, project: Project, snapshot: Snapshot, report: ImportReport): void {
  const db = store.db;
  const exists = db.prepare("SELECT 1 FROM runs WHERE id = ?");
  const insertRun = db.prepare(
    `INSERT INTO runs (id, project_id, issue_number, title, state, unsafe, branch, pr_number, build_iterations, review_rounds,
                       critic_rounds, resync_rounds, round, waiting_gate, parked_from, created_at, updated_at)
     VALUES (@id, @project_id, @issue_number, @title, @state, @unsafe, @branch, @pr_number, @build_iterations, @review_rounds,
             @critic_rounds, @resync_rounds, @round, @waiting_gate, @parked_from, @created_at, @updated_at)`,
  );
  const added = new Set<string>();
  for (const run of snapshot.runs) {
    if (exists.get(run.id)) {
      if (!added.has(run.id)) report.runs.present++;
      continue;
    }
    insertRun.run({ ...run, project_id: project.id, unsafe: run.unsafe ? 1 : 0 });
    added.add(run.id);
    report.runs.added.push(run.id);
  }

  // Rows with the same run, time and content are one row seen twice, not two.
  const sameEvent = db.prepare(
    "SELECT 1 FROM run_events WHERE run_id = ? AND created_at = ? AND from_state IS ? AND to_state = ? AND reason = ? AND data IS ?",
  );
  const insertEvent = db.prepare("INSERT INTO run_events (run_id, from_state, to_state, reason, data, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const e of snapshot.run_events) {
    if (!added.has(e.run_id) || sameEvent.get(e.run_id, e.created_at, e.from_state, e.to_state, e.reason, e.data)) continue;
    insertEvent.run(e.run_id, e.from_state, e.to_state, e.reason, e.data, e.created_at);
    report.run_events++;
  }

  const sameDecision = db.prepare(
    "SELECT 1 FROM decisions WHERE run_id = ? AND created_at = ? AND gate = ? AND mode = ? AND outcome = ? AND actor = ? AND comment = ? AND commit_sha IS ?",
  );
  const insertDecision = db.prepare(
    "INSERT INTO decisions (run_id, gate, mode, outcome, actor, comment, commit_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const d of snapshot.decisions) {
    if (!added.has(d.run_id) || sameDecision.get(d.run_id, d.created_at, d.gate, d.mode, d.outcome, d.actor, d.comment, d.commit_sha)) continue;
    insertDecision.run(d.run_id, d.gate, d.mode, d.outcome, d.actor, d.comment, d.commit_sha, d.created_at);
    report.decisions++;
  }

  const agentRunOf = db.prepare("SELECT run_id FROM agent_runs WHERE id = ?");
  const insertAgentRun = db.prepare(
    `INSERT INTO agent_runs (id, run_id, role, model, effort, session_id, status, cost_usd, input_tokens, output_tokens, excerpt, started_at, ended_at)
     VALUES (@id, @run_id, @role, @model, @effort, @session_id, @status, @cost_usd, @input_tokens, @output_tokens, @excerpt, @started_at, @ended_at)`,
  );
  for (const a of snapshot.agent_runs) {
    if (!added.has(a.run_id)) continue;
    const holder = agentRunOf.get(a.id) as { run_id: string } | undefined;
    if (holder) {
      if (holder.run_id !== a.run_id) report.agent_run_conflicts.push(a.id);
      continue;
    }
    insertAgentRun.run(a);
    report.agent_runs++;
  }
}

/**
 * The queue and `created_by_factory` are local decisions, so they merge; the GitHub mirror fields
 * are left to `factory sync`. A file can come from anywhere, so nothing in it is trusted as is:
 * - an issue new to this store gets no title, body, author, labels or url from the file: they stay
 *   empty, and `synced_at` stays `NEVER_SYNCED`, until a fetch from GitHub fills them (a run fetches first);
 * - a `created_by_factory` marker only becomes a pending claim (`FACTORY_CLAIM_PENDING`), which the
 *   next fetch from GitHub keeps only if the factory's own login opened the issue.
 * The schema keeps no time for an unqueue, so the rule is:
 * - both sides queued: the later `queued_at` wins (queuing again after a run means "run it again");
 * - one side queued: the queued side wins, so an import never drops work from the queue;
 * - an issue closed here, or closed in the snapshot, is never queued by an import.
 * An imported issue keeps the snapshot's `queued_at`, so the scheduler (which orders by `queued_at`,
 * then `queue_seq`) takes it in turn by when it was queued, among the local ones. Keeping the time
 * also keeps an imported finished run from counting as "before it was queued", which would start
 * the issue again. Only `queue_seq` is local: a fresh MAX+1, so it never collides with a local one.
 */
function mergeIssues(store: Store, project: Project, issues: SnapshotIssue[], report: ImportReport): void {
  const db = store.db;
  const nextSeq = () =>
    (db.prepare("SELECT COALESCE(MAX(queue_seq), 0) + 1 AS seq FROM issues WHERE project_id = ?").get(project.id) as { seq: number }).seq;
  const insert = db.prepare(
    `INSERT INTO issues (project_id, number, title, body, state, author, labels, url, gh_updated_at, synced_at, queued_at, queue_seq, created_by_factory)
     VALUES (@project_id, @number, @title, @body, @state, @author, @labels, @url, @gh_updated_at, @synced_at, @queued_at, @queue_seq, @created_by_factory)`,
  );
  const queue = db.prepare("UPDATE issues SET queued_at = ?, queue_seq = ? WHERE project_id = ? AND number = ?");
  const claimFactory = db.prepare("UPDATE issues SET created_by_factory = ? WHERE project_id = ? AND number = ? AND created_by_factory = 0");
  // In the snapshot's queue order, so the fresh queue_seq numbers keep the snapshot's ties in order.
  const ordered = [...issues].sort(
    (a, b) => (a.queued_at === null ? 1 : 0) - (b.queued_at === null ? 1 : 0) || time(a.queued_at) - time(b.queued_at) || (a.queue_seq ?? 0) - (b.queue_seq ?? 0) || a.number - b.number,
  );
  for (const issue of ordered) {
    const queuedThere = issue.state === "open" && issue.queued_at !== null;
    const local = store.getIssue(project.id, issue.number);
    if (!local) {
      // Only what would otherwise be lost: other issues come with the next sync anyway.
      if (!queuedThere && !issue.created_by_factory) continue;
      insert.run({
        project_id: project.id,
        number: issue.number,
        title: "",
        body: "",
        state: issue.state,
        author: "",
        labels: "[]",
        url: "",
        gh_updated_at: NEVER_SYNCED,
        // Before any sync, so the next one can still close it if GitHub no longer lists it as open.
        synced_at: NEVER_SYNCED,
        queued_at: queuedThere ? issue.queued_at : null,
        queue_seq: queuedThere ? nextSeq() : null,
        created_by_factory: issue.created_by_factory ? FACTORY_CLAIM_PENDING : 0,
      });
      report.issues.added.push(issue.number);
      continue;
    }
    if (issue.created_by_factory && claimFactory.run(FACTORY_CLAIM_PENDING, project.id, issue.number).changes > 0) {
      report.issues.created_by_factory.push(issue.number);
    }
    if (queuedThere && local.state === "open" && (local.queued_at === null || time(issue.queued_at) > time(local.queued_at))) {
      queue.run(issue.queued_at, nextSeq(), project.id, issue.number);
      report.issues.queued.push(issue.number);
    }
  }
}

/**
 * Lessons are matched on their run and rule. A decided lesson (approved or rejected) beats a
 * proposed copy; between two decided copies the later decision wins. A lesson whose run this store
 * does not have is skipped: its run was still active where it was exported.
 */
function mergeLessons(store: Store, project: Project, lessons: SnapshotLesson[], report: ImportReport): void {
  const db = store.db;
  const runProject = db.prepare("SELECT project_id FROM runs WHERE id = ?");
  const find = db.prepare("SELECT * FROM lessons WHERE project_id = ? AND run_id = ? AND rule = ? ORDER BY id LIMIT 1");
  const insert = db.prepare(
    `INSERT INTO lessons (project_id, run_id, status, observation, evidence, rule, comment, pull_request, created_at, decided_at)
     VALUES (@project_id, @run_id, @status, @observation, @evidence, @rule, @comment, @pull_request, @created_at, @decided_at)`,
  );
  const decide = db.prepare("UPDATE lessons SET status = ?, comment = ?, pull_request = ?, decided_at = ? WHERE id = ?");
  for (const lesson of lessons) {
    const owner = runProject.get(lesson.run_id) as { project_id: string } | undefined;
    if (owner?.project_id !== project.id) {
      report.lessons.missing_run++;
      continue;
    }
    const local = find.get(project.id, lesson.run_id, lesson.rule) as StoredLesson | undefined;
    if (!local) {
      insert.run({ ...lesson, project_id: project.id });
      report.lessons.added++;
    } else if (decidedLater(lesson, local)) {
      decide.run(lesson.status, lesson.comment, lesson.pull_request, lesson.decided_at, local.id);
      report.lessons.decided++;
    }
  }
}

function decidedLater(theirs: SnapshotLesson, ours: StoredLesson): boolean {
  if (theirs.status === "proposed") return false;
  if (ours.status === "proposed") return true;
  const same = theirs.status === ours.status && theirs.comment === ours.comment && theirs.pull_request === ours.pull_request && theirs.decided_at === ours.decided_at;
  return !same && time(theirs.decided_at) > time(ours.decided_at);
}

/** What `factory new --approve` already created: a union, so no draft creates its issues twice. */
function mergeDrafts(store: Store, project: Project, snapshot: Snapshot, report: ImportReport): void {
  const db = store.db;
  const issue = db.prepare(
    "INSERT OR IGNORE INTO draft_issues (project_id, draft_id, position, number, fingerprint, linked) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const d of snapshot.draft_issues) {
    report.draft_issues += issue.run(project.id, d.draft_id, d.position, d.number, d.fingerprint, d.linked ? 1 : 0).changes;
  }
  const done = db.prepare("INSERT OR IGNORE INTO drafts_done (project_id, draft_id, done_at) VALUES (?, ?, ?)");
  for (const d of snapshot.drafts_done) report.drafts_done += done.run(project.id, d.draft_id, d.done_at).changes;
}

/** Milliseconds of an ISO time, or -Infinity for none, so "later" also works across time zone offsets. */
function time(iso: string | null): number {
  return iso === null ? -Infinity : Date.parse(iso);
}
