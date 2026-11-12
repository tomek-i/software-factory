import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { RunState } from "@factory/shared";
import { MIGRATIONS } from "./migrations.js";
import { Store } from "./store.js";

function setup() {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: "/repo/demo" });
  return { store, project };
}

describe("Store", () => {
  it("migrates a file database once and reopens it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "factory-db-")), "nested", "factory.db");
    const first = new Store(path);
    first.upsertProject({ name: "a", repo_path: "/a" });
    first.close();

    const second = new Store(path);
    expect(second.listProjects().map((p) => p.name)).toEqual(["a"]);
    second.close();
  });

  it("numbers the round of existing runs after the folders they already have", () => {
    const path = join(mkdtempSync(join(tmpdir(), "factory-db-")), "factory.db");
    const store = new Store(path);
    const project = store.upsertProject({ name: "a", repo_path: "/a" });
    /** A run with these moves (`from>to`) behind it and the counter the old engine left. */
    const make = (build_iterations: number, moves: string[]) => {
      const run = store.createRun({ project_id: project.id, title: "t", issue_number: null });
      for (const move of moves) {
        const [from, to] = move.split(">") as [RunState, RunState];
        store.appendEvent(run.id, from, to, "x");
      }
      store.writeState(run.id, moves.at(-1)?.split(">")[1] as RunState, { build_iterations });
      return run.id;
    };
    // The old engine's folder was build_iterations + 1 at the time of the gate.
    const gateFailed = make(2, ["build>gate", "gate>build", "build>gate", "gate>build"]); // last used round-2
    const inGate = make(2, ["build>gate", "gate>build", "build>gate", "gate>build", "build>gate"]); // round-3
    const parkedInReview = make(1, ["build>gate", "gate>build", "build>gate", "gate>review", "review>needs_human"]); // round-2
    // Sent back from review by a human: the reviewed round-2 must not be reused.
    const sentBack = make(1, ["build>gate", "gate>build", "build>gate", "gate>review", "review>needs_human", "needs_human>build"]);
    const neverGated = make(0, ["intake>triage", "triage>needs_human"]);
    store.close();
    // Undo the round migration, as if this database was made before it.
    const roundMigration = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN round")) + 1;
    const db = new Database(path);
    db.exec("ALTER TABLE runs DROP COLUMN round");
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(roundMigration);
    db.close();

    const reopened = new Store(path);
    const round = (id: string) => reopened.getRun(id)!.round;
    expect([gateFailed, inGate, parkedInReview, sentBack, neverGated].map(round)).toEqual([2, 3, 2, 2, 0]);
    reopened.close();
  });

  it("upserts projects by repo path", () => {
    const { store, project } = setup();
    const again = store.upsertProject({ name: "renamed", repo_path: "/repo/demo", github_repo: "me/demo" });
    expect(again.id).toBe(project.id);
    expect(again.name).toBe("renamed");
    expect(store.listProjects()).toHaveLength(1);
  });

  it("creates runs in intake with a creation event", () => {
    const { store, project } = setup();
    const run = store.createRun({ project_id: project.id, title: "CSV export", issue_number: 42, unsafe: true });

    expect(run.state).toBe("intake");
    expect(run.unsafe).toBe(true);
    expect(run.id).toMatch(/^42-csv-export-[0-9a-f]{6}$/);
    expect(store.listEvents(run.id)).toMatchObject([{ from_state: null, to_state: "intake", data: { unsafe: true } }]);
  });

  it("names runs after the issue number and a slug of the title", () => {
    const { store, project } = setup();
    const long = store.createRun({ project_id: project.id, title: "Shorter builder summaries: one line per bullet!", issue_number: 49 });
    const adhoc = store.createRun({ project_id: project.id, title: "Ünïcode & spaces" });
    const again = store.createRun({ project_id: project.id, title: "Shorter builder summaries: one line per bullet!", issue_number: 49 });

    expect(long.id).toMatch(/^49-shorter-builder-summaries-one-[0-9a-f]{6}$/);
    expect(adhoc.id).toMatch(/^new-unicode-spaces-[0-9a-f]{6}$/);
    expect(again.id).not.toBe(long.id);
    expect(store.createRun({ project_id: project.id, title: "!!! ???", issue_number: 7 }).id).toMatch(/^7-work-[0-9a-f]{6}$/);
  });

  it("filters runs by project and state", () => {
    const { store, project } = setup();
    const a = store.createRun({ project_id: project.id, title: "a" });
    store.createRun({ project_id: project.id, title: "b" });
    store.writeState(a.id, "build");

    expect(store.listRuns({ states: ["build"] }).map((r) => r.title)).toEqual(["a"]);
    expect(store.listRuns({ project_id: project.id })).toHaveLength(2);
  });

  it("only lets one owner hold a lease until it expires", () => {
    const { store, project } = setup();
    const run = store.createRun({ project_id: project.id, title: "a" });

    expect(store.acquireLease(run.id, "worker-1", 60_000)).toBe(true);
    expect(store.acquireLease(run.id, "worker-2", 60_000)).toBe(false);
    expect(store.acquireLease(run.id, "worker-1", 60_000)).toBe(true);

    store.releaseLease(run.id, "worker-1");
    expect(store.acquireLease(run.id, "worker-2", -1)).toBe(true);
    // worker-2's lease is already expired, so another worker can take over a crashed run
    expect(store.acquireLease(run.id, "worker-3", 60_000)).toBe(true);
  });

  it("requires a comment on every decision", () => {
    const { store, project } = setup();
    const run = store.createRun({ project_id: project.id, title: "a" });
    const base = { run_id: run.id, gate: "merge", mode: "human", outcome: "approve", actor: "human" } as const;

    expect(() => store.recordDecision({ ...base, comment: "  " })).toThrow(/comment/);
    store.recordDecision({ ...base, comment: "looks good" });
    expect(store.listDecisions(run.id)).toMatchObject([{ outcome: "approve", comment: "looks good" }]);
  });
});

describe("Store issues created by the factory", () => {
  const input = (title: string) => ({
    number: 7,
    title,
    body: "b",
    state: "open" as const,
    author: "alice",
    labels: [],
    url: "https://github.com/o/r/issues/7",
    gh_updated_at: "2026-01-01T00:00:00Z",
  });

  it("starts unmarked, and keeps the mark when the issue is synced again", () => {
    const { store, project } = setup();
    store.upsertIssue(project.id, input("first"));
    expect(store.getIssue(project.id, 7)!.created_by_factory).toBe(false);

    store.markCreatedByFactory(project.id, 7);
    store.upsertIssue(project.id, input("edited on GitHub"));

    expect(store.getIssue(project.id, 7)).toMatchObject({ title: "edited on GitHub", created_by_factory: true });
    expect(store.listIssues({ project_id: project.id })[0]!.created_by_factory).toBe(true);
  });

  it("refuses to mark an issue that is not synced", () => {
    const { store, project } = setup();
    expect(() => store.markCreatedByFactory(project.id, 99)).toThrow(/not synced/);
  });

  it("adds the column to an existing database, unmarked", () => {
    const path = join(mkdtempSync(join(tmpdir(), "factory-db-")), "factory.db");
    const store = new Store(path);
    const project = store.upsertProject({ name: "a", repo_path: "/a" });
    store.upsertIssue(project.id, input("old"));
    store.close();
    // Undo the migration, as if this database was made before it.
    const version = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN created_by_factory")) + 1;
    const db = new Database(path);
    db.exec("ALTER TABLE issues DROP COLUMN created_by_factory");
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
    db.close();

    const reopened = new Store(path);
    expect(reopened.getIssue(project.id, 7)).toMatchObject({ title: "old", created_by_factory: false });
    reopened.close();
  });
});

describe("Store issue drafts", () => {
  it("records what was created from a draft, what was linked, and when it is finished", () => {
    const { store, project } = setup();
    expect(store.listDraftIssues(project.id, "draft-1")).toEqual([]);

    store.recordDraftIssue(project.id, "draft-1", { position: 1, number: 21, fingerprint: "b" });
    store.recordDraftIssue(project.id, "draft-1", { position: 0, number: 20, fingerprint: "a" });
    store.markDraftIssueLinked(project.id, "draft-1", 1);
    expect(() => store.recordDraftIssue(project.id, "draft-1", { position: 0, number: 99, fingerprint: "c" })).toThrow(/UNIQUE/);

    expect(store.listDraftIssues(project.id, "draft-1")).toEqual([
      { position: 0, number: 20, fingerprint: "a", linked: false },
      { position: 1, number: 21, fingerprint: "b", linked: true },
    ]);
    expect(store.listDraftIssues(project.id, "draft-2")).toEqual([]);
    expect(store.isDraftFinished(project.id, "draft-1")).toBe(false);
    store.finishDraft(project.id, "draft-1");
    store.finishDraft(project.id, "draft-1");
    expect(store.isDraftFinished(project.id, "draft-1")).toBe(true);
  });
});

describe("Store ports and agent runs", () => {
  it("hands out the lowest free port block and reuses blocks of finished runs", () => {
    const { store, project } = setup();
    const a = store.createRun({ project_id: project.id, title: "a" });
    const b = store.createRun({ project_id: project.id, title: "b" });
    const c = store.createRun({ project_id: project.id, title: "c" });

    expect(store.allocatePorts(a.id, 4700)).toBe(4700);
    expect(store.allocatePorts(b.id, 4700)).toBe(4710);
    expect(store.allocatePorts(a.id, 4700)).toBe(4700);

    store.writeState(a.id, "cancelled");
    expect(store.allocatePorts(c.id, 4700)).toBe(4700);
  });

  it("tracks agent runs and finds the latest session of a role", () => {
    const { store, project } = setup();
    const run = store.createRun({ project_id: project.id, title: "a" });
    const first = store.startAgentRun({ run_id: run.id, role: "builder", model: "opus", effort: "high", session_id: "s1", log_dir: "/logs" });
    store.setAgentPid(first.id, 1234);
    expect(store.getAgentRun(first.id)).toMatchObject({ status: "running", pid: 1234, model: "opus", effort: "high" });
    expect(first.log_path!.endsWith(`${first.id}.jsonl`)).toBe(true);

    store.finishAgentRun(first.id, { status: "ok", cost_usd: 0.5 });
    store.startAgentRun({ run_id: run.id, role: "builder", model: "opus", session_id: "s2", log_dir: "/logs" });
    store.startAgentRun({ run_id: run.id, role: "triage", model: "opus", session_id: "t1", log_dir: "/logs" });

    expect(store.getAgentRun(first.id)).toMatchObject({ status: "ok", cost_usd: 0.5, pid: null });
    expect(store.latestSession(run.id, "builder")).toBe("s2");
    expect(store.latestSession(run.id, "critic")).toBeUndefined();
  });

  it("updates bookkeeping fields without touching state", () => {
    const { store, project } = setup();
    const run = store.createRun({ project_id: project.id, title: "a" });
    store.updateRunFields(run.id, { branch: "factory/1-a", pr_number: undefined });
    expect(store.getRun(run.id)).toMatchObject({ branch: "factory/1-a", state: "intake", pr_number: null });
  });
});

describe("Store lessons", () => {
  const lesson = (rule: string) => ({ observation: "the gate failed twice", evidence: "round-1/checks.md", rule });

  it("stores proposals per run and lists them by status", () => {
    const { store, project } = setup();
    const other = store.upsertProject({ name: "other", repo_path: "/repo/other" });
    const run = store.createRun({ project_id: project.id, title: "a", issue_number: 1 });
    const elsewhere = store.createRun({ project_id: other.id, title: "b", issue_number: 1 });

    const added = store.addLessons(run.id, [lesson("Run lint first."), lesson("Keep tests next to the code.")]);
    store.addLessons(elsewhere.id, [lesson("Not this project's.")]);

    expect(added).toMatchObject([
      { project_id: project.id, run_id: run.id, status: "proposed", rule: "Run lint first.", comment: null, pull_request: null, decided_at: null },
      { rule: "Keep tests next to the code." },
    ]);
    expect(store.listLessons({ project_id: project.id }).map((l) => l.rule)).toEqual(["Run lint first.", "Keep tests next to the code."]);
    expect(store.listLessons({ project_id: project.id, status: "approved" })).toEqual([]);
    expect(store.addLessons(run.id, [])).toEqual([]);
    expect(() => store.addLessons("run-missing", [lesson("x")])).toThrow(/not found/);
  });

  it("records a decision once, and all or none of a batch", () => {
    const { store, project } = setup();
    const run = store.createRun({ project_id: project.id, title: "a" });
    const [a, b, c] = store.addLessons(run.id, [lesson("a"), lesson("b"), lesson("c")]);

    expect(store.decideLessons([a!.id, b!.id], "approved", { pull_request: 9 })).toMatchObject([
      { status: "approved", pull_request: 9, decided_at: expect.any(String) },
      { status: "approved", pull_request: 9 },
    ]);
    // b is already approved, so c is left as it was.
    expect(() => store.decideLessons([c!.id, b!.id], "rejected", { comment: "too vague" })).toThrow(`lesson ${b!.id} is not waiting for a decision`);
    expect(store.getLesson(c!.id)).toMatchObject({ status: "proposed", comment: null });

    expect(store.decideLessons([c!.id], "rejected", { comment: "too vague" })).toMatchObject([{ status: "rejected", comment: "too vague", pull_request: null }]);
    expect(store.listLessons({ project_id: project.id, status: "proposed" })).toEqual([]);
  });
});
