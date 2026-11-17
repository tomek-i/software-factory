import { describe, expect, it } from "vitest";
import type { Snapshot } from "@factory/shared";
import { MIGRATIONS } from "./migrations.js";
import { exportSnapshot, importChangeCount, importSnapshot, schemaVersion } from "./snapshot.js";
import { FACTORY_CLAIM_PENDING, fetchedFromGithub, NEVER_SYNCED, Store, type IssueInput } from "./store.js";

const NOW = new Date("2026-11-16T10:00:00.000Z");

function machine(repoPath: string, githubRepo: string | null = "o/r") {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: repoPath, github_repo: githubRepo });
  return { store, project };
}

const issue = (number: number, state: "open" | "closed" = "open"): IssueInput => ({
  number,
  title: `Issue ${number}`,
  body: "body",
  state,
  author: "alice",
  labels: ["bug"],
  url: `https://github.com/o/r/issues/${number}`,
  gh_updated_at: "2026-01-01T00:00:00Z",
});

/** Every table's row count, to show an import changed nothing. */
function counts(store: Store): Record<string, number> {
  const tables = ["projects", "issues", "runs", "run_events", "decisions", "agent_runs", "lessons", "draft_issues", "drafts_done"];
  return Object.fromEntries(tables.map((t) => [t, (store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));
}

/** Everything but the run ids' rows, in a comparable form. */
function dump(store: Store): unknown {
  const all = (sql: string) => store.db.prepare(sql).all();
  return {
    issues: all("SELECT * FROM issues ORDER BY number"),
    runs: all("SELECT * FROM runs ORDER BY id"),
    run_events: all("SELECT * FROM run_events ORDER BY id"),
    decisions: all("SELECT * FROM decisions ORDER BY id"),
    agent_runs: all("SELECT * FROM agent_runs ORDER BY id"),
    lessons: all("SELECT * FROM lessons ORDER BY id"),
    draft_issues: all("SELECT * FROM draft_issues"),
    drafts_done: all("SELECT * FROM drafts_done"),
  };
}

/** Machine A: a finished run with everything attached, an active run, a queue, lessons and drafts. */
function laptop() {
  const a = machine("/laptop/repo");
  const { store, project } = a;
  for (const n of [1, 2, 3, 4]) store.upsertIssue(project.id, issue(n));
  store.upsertIssue(project.id, issue(5, "closed"));
  store.setQueued(project.id, 2, true);
  store.setQueued(project.id, 3, true);
  store.markCreatedByFactory(project.id, 4);

  const done = store.createRun({ project_id: project.id, title: "Fix it", issue_number: 1 });
  store.appendEvent(done.id, "intake", "triage", "triaged", { note: "ok" });
  store.recordDecision({ run_id: done.id, gate: "merge", mode: "human", outcome: "approve", actor: "human", comment: "ship it", commit_sha: "a".repeat(40) });
  const agent = store.startAgentRun({ run_id: done.id, role: "builder", model: "opus", effort: "high", session_id: "s1", log_dir: "/laptop/logs" });
  store.setAgentPid(agent.id, 4242);
  store.finishAgentRun(agent.id, { status: "ok", cost_usd: 1.25, input_tokens: 1000, output_tokens: 200, excerpt: "done" });
  store.allocatePorts(done.id, 4700);
  store.acquireLease(done.id, "worker-a", 60_000);
  store.updateRunFields(done.id, { worktree_path: "/laptop/repo/.worktrees/x", branch: "factory/1-fix-it", pr_number: 9 });
  store.writeState(done.id, "done");
  const [proposed, approved, rejected] = store.addLessons(done.id, [
    { observation: "o1", evidence: "e1", rule: "Rule one." },
    { observation: "o2", evidence: "e2", rule: "Rule two." },
    { observation: "o3", evidence: "e3", rule: "Rule three." },
  ]);
  store.decideLessons([approved!.id], "approved", { pull_request: 11 });
  store.decideLessons([rejected!.id], "rejected", { comment: "no" });

  const active = store.createRun({ project_id: project.id, title: "Still going", issue_number: 2 });
  store.writeState(active.id, "needs_human", { waiting_gate: "merge" });
  store.addLessons(active.id, [{ observation: "o", evidence: "e", rule: "Active run's rule." }]);

  store.recordDraftIssue(project.id, "draft-abc12345", { position: 0, number: 4, fingerprint: "f0" });
  store.markDraftIssueLinked(project.id, "draft-abc12345", 0);
  store.finishDraft(project.id, "draft-abc12345");
  return { ...a, done, active, agent, lessonIds: { proposed: proposed!.id, approved: approved!.id, rejected: rejected!.id } };
}

/** The snapshot as it travels: through JSON text. */
const carry = (snapshot: Snapshot): unknown => JSON.parse(JSON.stringify(snapshot));

describe("exportSnapshot", () => {
  it("writes a header and the finished runs, leaving out active runs and machine-local columns", () => {
    const { store, project, done, active, agent } = laptop();
    const { snapshot, skipped } = exportSnapshot(store, project, { now: NOW, host: "laptop" });

    expect(snapshot.header).toEqual({ format_version: 1, schema_version: MIGRATIONS.length, exported_at: NOW.toISOString(), host: "laptop", github_repo: "o/r" });
    expect(skipped).toEqual([active.id]);
    expect(snapshot.runs.map((r) => r.id)).toEqual([done.id]);
    expect(snapshot.runs[0]).toMatchObject({ state: "done", branch: "factory/1-fix-it", pr_number: 9, unsafe: false });
    expect(snapshot.run_events.every((e) => e.run_id === done.id)).toBe(true);
    expect(snapshot.run_events.map((e) => e.data)).toContain(JSON.stringify({ note: "ok" }));
    expect(snapshot.decisions).toEqual([expect.objectContaining({ run_id: done.id, comment: "ship it" })]);
    expect(snapshot.agent_runs).toEqual([expect.objectContaining({ id: agent.id, cost_usd: 1.25, input_tokens: 1000, output_tokens: 200, effort: "high" })]);
    expect(snapshot.lessons.map((l) => l.rule)).toEqual(["Rule one.", "Rule two.", "Rule three."]);
    expect(snapshot.issues.map((i) => i.number)).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.issues[0]!.labels).toEqual(["bug"]);
    expect(snapshot.draft_issues).toEqual([{ draft_id: "draft-abc12345", position: 0, number: 4, fingerprint: "f0", linked: true }]);
    expect(snapshot.drafts_done).toEqual([expect.objectContaining({ draft_id: "draft-abc12345" })]);

    const text = JSON.stringify(snapshot);
    for (const local of ["repo_path", "worktree_path", "port_base", "lease_owner", "lease_expires_at", "pid", "log_path", "project_id", "/laptop"]) {
      expect(text).not.toContain(local);
    }
  });

  it("refuses a project without a GitHub repository", () => {
    const { store, project } = machine("/repo", null);
    expect(() => exportSnapshot(store, project)).toThrow(/no GitHub repository/);
  });
});

describe("importSnapshot", () => {
  it("round-trips into a fresh store with another path, and a second import changes nothing", () => {
    const a = laptop();
    const { snapshot } = exportSnapshot(a.store, a.project, { now: NOW, host: "laptop" });
    const b = machine("/home/elsewhere/repo");

    const report = importSnapshot(b.store, b.project, carry(snapshot));
    expect(report.runs).toEqual({ added: [a.done.id], present: 0 });
    expect(report.issues).toEqual({ added: [2, 3, 4], queued: [], created_by_factory: [] });
    expect(report).toMatchObject({ run_events: 2, decisions: 1, agent_runs: 1, lessons: { added: 3, decided: 0, missing_run: 0 }, draft_issues: 1, drafts_done: 1 });

    // The queue keeps its order; the factory's marker comes as a claim the next fetch settles.
    expect(b.store.listIssues({ project_id: b.project.id, queued: true }).map((i) => [i.number, i.queued_at])).toEqual(
      a.store.listIssues({ project_id: a.project.id, queued: true }).map((i) => [i.number, i.queued_at]),
    );
    expect(b.store.getIssue(b.project.id, 4)?.created_by_factory).toBe(false);
    expect(b.store.pendingFactoryClaims(b.project.id, [2, 3, 4])).toEqual([4]);
    expect(b.store.getIssue(b.project.id, 1)).toBeUndefined(); // neither queued nor the factory's: the next sync brings it
    expect(b.store.listLessons({ project_id: b.project.id }).map((l) => [l.rule, l.status, l.comment, l.pull_request])).toEqual([
      ["Rule one.", "proposed", null, null],
      ["Rule two.", "approved", null, 11],
      ["Rule three.", "rejected", "no", null],
    ]);
    expect(b.store.listDraftIssues(b.project.id, "draft-abc12345")).toEqual([{ position: 0, number: 4, fingerprint: "f0", linked: true }]);
    expect(b.store.isDraftFinished(b.project.id, "draft-abc12345")).toBe(true);

    const run = b.store.getRun(a.done.id)!;
    expect(run).toMatchObject({ project_id: b.project.id, state: "done", pr_number: 9, worktree_path: null, port_base: null, lease_owner: null, lease_expires_at: null });
    expect(b.store.listEvents(run.id).map((e) => e.reason)).toEqual(a.store.listEvents(run.id).map((e) => e.reason));
    expect(b.store.listDecisions(run.id)).toHaveLength(1);
    expect(b.store.listAgentRuns(run.id)).toEqual([expect.objectContaining({ id: a.agent.id, cost_usd: 1.25, input_tokens: 1000, pid: null, log_path: null })]);
    expect(b.store.getRun(a.active.id)).toBeUndefined();

    const before = dump(b.store);
    const again = importSnapshot(b.store, b.project, carry(snapshot));
    expect(importChangeCount(again)).toBe(0);
    expect(again.runs.present).toBe(1);
    expect(dump(b.store)).toEqual(before);
  });

  it("merges into a store that has its own state, leaving runs it already has alone", () => {
    const a = laptop();
    const { snapshot } = exportSnapshot(a.store, a.project, { now: NOW });
    const b = machine("/home/repo");
    importSnapshot(b.store, b.project, carry(snapshot));
    // B adds its own work; A's run, which B already has, gains an event on A afterwards.
    b.store.upsertIssue(b.project.id, issue(7));
    b.store.setQueued(b.project.id, 7, true);
    a.store.appendEvent(a.done.id, "done", "done", "noted later");
    const later = exportSnapshot(a.store, a.project).snapshot;

    const report = importSnapshot(b.store, b.project, carry(later));
    expect(report.runs).toEqual({ added: [], present: 1 });
    expect(report.run_events).toBe(0);
    expect(b.store.listEvents(a.done.id).map((e) => e.reason)).not.toContain("noted later");
    expect(b.store.getIssue(b.project.id, 7)?.queued_at).not.toBeNull();
  });

  describe("queue", () => {
    function both() {
      const a = machine("/a");
      const b = machine("/b");
      for (const s of [a, b]) for (const n of [1, 2, 3, 4, 5]) s.store.upsertIssue(s.project.id, issue(n));
      const set = (s: typeof a, n: number, queuedAt: string | null, seq: number | null) =>
        s.store.db.prepare("UPDATE issues SET queued_at = ?, queue_seq = ? WHERE project_id = ? AND number = ?").run(queuedAt, seq, s.project.id, n);
      return { a, b, set };
    }

    it("keeps the later queue time, and the queued side when only one side is queued", () => {
      const { a, b, set } = both();
      set(b, 4, "2026-01-01T00:00:00.000Z", 5); // B's own queue position
      set(a, 1, "2026-02-01T00:00:00.000Z", 1); // both queued, A later: A's time wins
      set(b, 1, "2026-01-15T00:00:00.000Z", 1);
      set(a, 2, "2026-01-01T00:00:00.000Z", 2); // both queued, B later: B's stays
      set(b, 2, "2026-03-01T00:00:00.000Z", 2);
      set(a, 3, "2026-01-01T00:00:00.000Z", 3); // only A queued: queued
      set(b, 5, "2026-01-01T00:00:00.000Z", 6); // only B queued: stays queued

      const report = importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot));
      expect(report.issues.queued.sort()).toEqual([1, 3]);
      const queued = (n: number) => b.store.getIssue(b.project.id, n)!;
      expect(queued(1).queued_at).toBe("2026-02-01T00:00:00.000Z");
      expect(queued(2).queued_at).toBe("2026-03-01T00:00:00.000Z");
      expect(queued(3).queued_at).toBe("2026-01-01T00:00:00.000Z");
      expect(queued(5).queued_at).toBe("2026-01-01T00:00:00.000Z");
      // Changed issues go after the local queue rather than reusing A's positions.
      expect([queued(1).queue_seq, queued(3).queue_seq].every((seq) => seq! > 6)).toBe(true);
      expect(importChangeCount(importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot)))).toBe(0);
    });

    it("keeps an imported issue's queue time, so it takes its turn by it, with a fresh local queue_seq", () => {
      const { a, b, set } = both();
      a.store.upsertIssue(a.project.id, issue(9));
      set(a, 9, "2026-01-01T00:00:00.000Z", 1); // queued on A before B's own
      set(b, 2, "2026-03-01T00:00:00.000Z", 4);

      importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot));
      const imported = b.store.getIssue(b.project.id, 9)!;
      expect(imported).toMatchObject({ queued_at: "2026-01-01T00:00:00.000Z", queue_seq: 5 });
      // The scheduler orders by queued_at first (scheduler.ts newStarts): the imported issue comes before B's.
      expect(imported.queued_at! < b.store.getIssue(b.project.id, 2)!.queued_at!).toBe(true);
    });

    it("never queues an issue that is closed on either side", () => {
      const { a, b, set } = both();
      set(a, 1, "2026-01-01T00:00:00.000Z", 1);
      b.store.upsertIssue(b.project.id, issue(1, "closed"));
      const snapshot = carry(exportSnapshot(a.store, a.project).snapshot) as Snapshot;
      // A closed, queued row can only come from a hand-edited file.
      snapshot.issues.push({ ...snapshot.issues[0]!, number: 9, state: "closed", queued_at: "2026-01-01T00:00:00.000Z", queue_seq: 9 });

      const report = importSnapshot(b.store, b.project, snapshot);
      expect(report.issues).toEqual({ added: [], queued: [], created_by_factory: [] });
      expect(b.store.getIssue(b.project.id, 1)?.queued_at).toBeNull();
      expect(b.store.getIssue(b.project.id, 9)).toBeUndefined();
    });

    it("takes created_by_factory only as a claim for GitHub to settle, and never clears a local one", () => {
      const { a, b } = both();
      a.store.markCreatedByFactory(a.project.id, 1);
      b.store.markCreatedByFactory(b.project.id, 2);
      const report = importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot));
      expect(report.issues.created_by_factory).toEqual([1]);
      // Not trusted on the file's word: issue 1 waits for a fetch from GitHub.
      expect(b.store.getIssue(b.project.id, 1)?.created_by_factory).toBe(false);
      expect(b.store.pendingFactoryClaims(b.project.id, [1, 2])).toEqual([1]);
      expect(b.store.getIssue(b.project.id, 2)?.created_by_factory).toBe(true);
      // A second import of the same claim changes nothing.
      expect(importChangeCount(importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot)))).toBe(0);
    });

    it("plants no trust for an issue number GitHub does not have yet", () => {
      const { a, b } = both();
      const snapshot = carry(exportSnapshot(a.store, a.project).snapshot) as Snapshot;
      // A crafted file: issue 99 does not exist yet, so whoever opens it next would get it.
      snapshot.issues.push({ ...snapshot.issues[0]!, number: 99, author: "mallory", created_by_factory: true });
      importSnapshot(b.store, b.project, snapshot);
      expect(b.store.getIssue(b.project.id, 99)).toMatchObject({ created_by_factory: false, author: "" });
      expect(b.store.db.prepare("SELECT created_by_factory FROM issues WHERE project_id = ? AND number = 99").get(b.project.id)).toEqual({
        created_by_factory: FACTORY_CLAIM_PENDING,
      });
    });

    it("takes none of a new issue's GitHub fields from the file, so a fetch must fill them before use", () => {
      const { a, b, set } = both();
      a.store.upsertIssue(a.project.id, { ...issue(9), title: "\u001b]8;;https://evil.example\u0007click", author: "mallory" });
      set(a, 9, "2026-01-01T00:00:00.000Z", 1);
      const snapshot = carry(exportSnapshot(a.store, a.project).snapshot) as Snapshot;
      snapshot.issues.find((i) => i.number === 9)!.url = "javascript:alert(1)";
      importSnapshot(b.store, b.project, snapshot);
      const imported = b.store.getIssue(b.project.id, 9)!;
      expect(imported).toMatchObject({ title: "", body: "", author: "", labels: [], url: "", gh_updated_at: NEVER_SYNCED, synced_at: NEVER_SYNCED });
      expect(imported.queued_at).toBe("2026-01-01T00:00:00.000Z");
      expect(fetchedFromGithub(imported)).toBe(false);
      expect(fetchedFromGithub(b.store.getIssue(b.project.id, 1)!)).toBe(true);
    });

    it("leaves the GitHub mirror fields of an existing issue to sync", () => {
      const { a, b } = both();
      a.store.upsertIssue(a.project.id, { ...issue(1), title: "Renamed on A", state: "closed" });
      importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot));
      expect(b.store.getIssue(b.project.id, 1)).toMatchObject({ title: "Issue 1", state: "open" });
    });
  });

  describe("lessons", () => {
    /** The same finished run with one lesson on both machines, decided as given. */
    function lessonOnBoth(onA: (s: Store, id: number) => void, onB: (s: Store, id: number) => void) {
      const a = machine("/a");
      const run = a.store.createRun({ project_id: a.project.id, title: "t", issue_number: 1 });
      a.store.writeState(run.id, "done");
      a.store.addLessons(run.id, [{ observation: "o", evidence: "e", rule: "The rule." }]);
      const b = machine("/b");
      importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot));
      onA(a.store, a.store.listLessons({ project_id: a.project.id })[0]!.id);
      onB(b.store, b.store.listLessons({ project_id: b.project.id })[0]!.id);
      const report = importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot));
      return { report, lessons: b.store.listLessons({ project_id: b.project.id }) };
    }
    const at = (store: Store, id: number, iso: string) => store.db.prepare("UPDATE lessons SET decided_at = ? WHERE id = ?").run(iso, id);

    it("takes a decision made elsewhere over a proposed copy", () => {
      const { report, lessons } = lessonOnBoth((s, id) => s.decideLessons([id], "approved", { pull_request: 3 }), () => undefined);
      expect(report.lessons).toEqual({ added: 0, decided: 1, missing_run: 0 });
      expect(lessons).toEqual([expect.objectContaining({ status: "approved", pull_request: 3 })]);
    });

    it("keeps a local decision over a proposed copy", () => {
      const { report, lessons } = lessonOnBoth(() => undefined, (s, id) => s.decideLessons([id], "rejected", { comment: "no" }));
      expect(report.lessons.decided).toBe(0);
      expect(lessons).toEqual([expect.objectContaining({ status: "rejected", comment: "no" })]);
    });

    it("keeps the later of two decisions", () => {
      const later = lessonOnBoth(
        (s, id) => (s.decideLessons([id], "rejected", { comment: "on A" }), at(s, id, "2026-02-01T00:00:00.000Z")),
        (s, id) => (s.decideLessons([id], "approved", { pull_request: 4 }), at(s, id, "2026-01-01T00:00:00.000Z")),
      );
      expect(later.lessons).toEqual([expect.objectContaining({ status: "rejected", comment: "on A", pull_request: null, decided_at: "2026-02-01T00:00:00.000Z" })]);
      const earlier = lessonOnBoth(
        (s, id) => (s.decideLessons([id], "rejected", { comment: "on A" }), at(s, id, "2026-01-01T00:00:00.000Z")),
        (s, id) => (s.decideLessons([id], "approved", { pull_request: 4 }), at(s, id, "2026-02-01T00:00:00.000Z")),
      );
      expect(earlier.report.lessons.decided).toBe(0);
      expect(earlier.lessons).toEqual([expect.objectContaining({ status: "approved", pull_request: 4 })]);
    });

    it("skips lessons whose run this store does not have", () => {
      const a = laptop();
      const snapshot = carry(exportSnapshot(a.store, a.project).snapshot) as Snapshot;
      snapshot.lessons.push({ ...snapshot.lessons[0]!, run_id: "9-elsewhere-abc123", rule: "Orphan." });
      const b = machine("/b");
      const report = importSnapshot(b.store, b.project, snapshot);
      expect(report.lessons).toEqual({ added: 3, decided: 0, missing_run: 1 });
    });
  });

  it("carries the re-sync counter, and takes 0 from a file made before it existed", () => {
    const a = laptop();
    const id = a.store.listRuns({ project_id: a.project.id }).find((r) => r.state === "done")!.id;
    a.store.writeState(id, "done", { resync_rounds: 2 });
    const snapshot = carry(exportSnapshot(a.store, a.project).snapshot) as Snapshot;
    const b = machine("/b");
    importSnapshot(b.store, b.project, snapshot);
    expect(b.store.getRun(id)!.resync_rounds).toBe(2);

    for (const run of snapshot.runs) delete (run as { resync_rounds?: number }).resync_rounds;
    const c = machine("/c");
    importSnapshot(c.store, c.project, snapshot);
    expect(c.store.getRun(id)!.resync_rounds).toBe(0);
  });

  it("skips an agent run whose id this store has under another run", () => {
    const a = laptop();
    const b = machine("/b");
    const own = b.store.createRun({ project_id: b.project.id, title: "own", issue_number: 8 });
    b.store.db
      .prepare("INSERT INTO agent_runs (id, run_id, role, status, started_at) VALUES (?, ?, 'builder', 'ok', ?)")
      .run(a.agent.id, own.id, NOW.toISOString());
    const report = importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot));
    expect(report.agent_run_conflicts).toEqual([a.agent.id]);
    expect(report.agent_runs).toBe(0);
    expect(b.store.getAgentRun(a.agent.id)?.run_id).toBe(own.id);
  });

  it("reports the same changes with dryRun and writes nothing", () => {
    const a = laptop();
    const snapshot = carry(exportSnapshot(a.store, a.project).snapshot);
    const b = machine("/b");
    const before = dump(b.store);
    const dry = importSnapshot(b.store, b.project, snapshot, { dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dump(b.store)).toEqual(before);
    const real = importSnapshot(b.store, b.project, snapshot);
    expect({ ...dry, dryRun: false }).toEqual(real);
  });

  it("changes nothing when the import fails half way", () => {
    const a = laptop();
    const b = machine("/b");
    // Lessons merge after runs and issues, so this fails with those already written.
    b.store.db.exec("CREATE TRIGGER boom BEFORE INSERT ON lessons BEGIN SELECT RAISE(ABORT, 'disk on fire'); END");
    const before = counts(b.store);
    expect(() => importSnapshot(b.store, b.project, carry(exportSnapshot(a.store, a.project).snapshot))).toThrow(/disk on fire/);
    expect(counts(b.store)).toEqual(before);
  });

  describe("refuses", () => {
    const refuse = (mutate: (s: Record<string, unknown> & { header: Record<string, unknown> }) => void, message: RegExp, target = machine("/b")) => {
      const a = laptop();
      const snapshot = carry(exportSnapshot(a.store, a.project).snapshot) as Record<string, unknown> & { header: Record<string, unknown> };
      mutate(snapshot);
      const before = counts(target.store);
      expect(() => importSnapshot(target.store, target.project, snapshot)).toThrow(message);
      expect(counts(target.store)).toEqual(before);
    };

    it("another repository's snapshot", () => {
      refuse((s) => (s.header.github_repo = "someone/else"), /The snapshot is of someone\/else, but this repository is o\/r/);
    });

    it("a project with no GitHub repository", () => {
      refuse(() => undefined, /no GitHub repository/, machine("/b", null));
    });

    it("a snapshot from a newer database schema, and accepts an older one", () => {
      refuse((s) => (s.header.schema_version = MIGRATIONS.length + 1), new RegExp(`newer factory \\(database schema ${MIGRATIONS.length + 1}, this one has ${MIGRATIONS.length}\\)\\. Upgrade`));
      const a = laptop();
      const older = carry(exportSnapshot(a.store, a.project).snapshot) as Snapshot;
      older.header.schema_version = MIGRATIONS.length - 1;
      const b = machine("/b");
      expect(importSnapshot(b.store, b.project, older).runs.added).toHaveLength(1);
    });

    it("a newer file format", () => {
      refuse((s) => (s.header.format_version = 2), /newer factory \(format 2, this one reads 1\)/);
    });

    it("something that is not a snapshot", () => {
      const b = machine("/b");
      expect(() => importSnapshot(b.store, b.project, [1, 2])).toThrow(/not a factory snapshot: it has no header/);
      expect(() => importSnapshot(b.store, b.project, { header: { format_version: 1 } })).toThrow(/not a factory snapshot: header\.schema_version/);
    });

    it("a damaged or crafted row, before writing anything", () => {
      refuse((s) => ((s.runs as { id: string }[])[0]!.id = "../../evil"), /damaged, nothing was imported: runs\[0\]\.id: not a run id/);
      refuse((s) => ((s.runs as { state: string }[])[0]!.state = "build"), /runs\[0\]\.state/);
      refuse((s) => ((s.run_events as { data: string }[])[0]!.data = "{not json"), /run_events\[0\]\.data: not JSON/);
      refuse((s) => ((s.issues as { queued_at: string }[])[1]!.queued_at = "tomorrow"), /issues\[1\]\.queued_at/);
      refuse((s) => ((s.draft_issues as { draft_id: string }[])[0]!.draft_id = "../x"), /draft_issues\[0\]\.draft_id/);
      refuse((s) => delete s.lessons, /lessons/);
    });
  });

  it("ignores columns it does not know instead of writing them", () => {
    const a = laptop();
    const snapshot = carry(exportSnapshot(a.store, a.project).snapshot) as Snapshot & { runs: Record<string, unknown>[] };
    snapshot.runs[0]!.worktree_path = "/evil";
    snapshot.runs[0]!.lease_owner = "x";
    const b = machine("/b");
    importSnapshot(b.store, b.project, snapshot);
    expect(b.store.getRun(a.done.id)).toMatchObject({ worktree_path: null, lease_owner: null });
  });

  it("reads the schema version from the applied migrations", () => {
    expect(schemaVersion(new Store(":memory:"))).toBe(MIGRATIONS.length);
  });
});
