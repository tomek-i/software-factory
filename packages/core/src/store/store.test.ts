import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
