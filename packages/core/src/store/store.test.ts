import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
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
    const make = (state: Parameters<Store["writeState"]>[1], build_iterations: number, parked_from: string | null = null) => {
      const run = store.createRun({ project_id: project.id, title: "t", issue_number: null });
      store.writeState(run.id, state, { build_iterations, parked_from: parked_from as never });
      return run.id;
    };
    const building = make("build", 2);
    const gated = make("gate", 2);
    const reviewing = make("review", 1);
    const parkedInReview = make("needs_human", 1, "review");
    const parkedInTriage = make("needs_human", 0, "triage");
    store.close();
    // Undo the round migration, as if this database was made before it.
    const roundMigration = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN round")) + 1;
    const db = new Database(path);
    db.exec("ALTER TABLE runs DROP COLUMN round");
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(roundMigration);
    db.close();

    const reopened = new Store(path);
    const round = (id: string) => reopened.getRun(id)!.round;
    // A run in build last gated in round build_iterations; one at or past the gate is in round build_iterations + 1.
    expect([building, gated, reviewing, parkedInReview, parkedInTriage].map(round)).toEqual([2, 3, 2, 2, 0]);
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
    expect(run.id).toMatch(/^run-42-/);
    expect(store.listEvents(run.id)).toMatchObject([{ from_state: null, to_state: "intake", data: { unsafe: true } }]);
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
