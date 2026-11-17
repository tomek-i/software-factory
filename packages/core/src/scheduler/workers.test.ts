import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { tempDir } from "../../test/helpers.js";
import type { ProjectContext } from "../service/project.js";
import { Store } from "../store/store.js";
import { Scheduler } from "./scheduler.js";
import { liveLeases, liveWorkers, registerWorker, workersDir } from "./workers.js";

const MINUTE = 60_000;

describe("worker presence", () => {
  it("lives in the factory's data folder", () => {
    expect(workersDir({ FACTORY_DATA_DIR: "/data" })).toBe(join("/data", "workers"));
  });

  it("lists a registered worker until it unregisters", () => {
    const dir = join(tempDir(), "workers");
    expect(liveWorkers(dir)).toEqual([]);

    const unregister = registerWorker(dir, 4242);
    const [worker] = liveWorkers(dir, (pid) => pid === 4242);
    expect(worker?.pid).toBe(4242);

    unregister();
    expect(liveWorkers(dir, () => true)).toEqual([]);
  });

  it("drops the file of a worker whose process is gone", () => {
    const dir = join(tempDir(), "workers");
    registerWorker(dir, 4242);

    expect(liveWorkers(dir, () => false)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("ignores this process and files it can't read", () => {
    const dir = join(tempDir(), "workers");
    registerWorker(dir, process.pid);
    writeFileSync(join(dir, "junk.json"), "{ nope");

    expect(liveWorkers(dir, () => true)).toEqual([]);
  });

  it("is held by a running scheduler, and given up when it stops", async () => {
    const scheduler = new Scheduler({ projects: () => [], stopRequest: () => undefined, tickMs: 5 });
    const controller = new AbortController();

    const result = scheduler.run(controller.signal);
    const files = readdirSync(workersDir());
    expect(files).toHaveLength(1);

    controller.abort();
    await result;
    expect(existsSync(join(workersDir(), files[0]!))).toBe(false);
  });
});

describe("liveLeases", () => {
  function project(name: string) {
    const store = new Store(":memory:");
    const row = store.upsertProject({ name, repo_path: `/repos/${name}`, github_repo: `acme/${name}` });
    const ctx: ProjectContext = { root: row.repo_path, config: factoryConfigSchema.parse({ version: 1 }), store, project: row };
    return { store, row, ctx, entry: { path: row.repo_path, name, added_at: "t" } };
  }

  it("lists runs with an unexpired lease, and skips expired ones and projects that don't open", () => {
    const shop = project("shop");
    const held = shop.store.createRun({ project_id: shop.row.id, title: "Add thing", issue_number: 12 });
    shop.store.acquireLease(held.id, "work-1-abc", 15 * MINUTE);
    const expired = shop.store.createRun({ project_id: shop.row.id, title: "Old thing", issue_number: 13 });
    shop.store.acquireLease(expired.id, "work-2-def", -MINUTE);
    shop.store.createRun({ project_id: shop.row.id, title: "Idle thing", issue_number: 14 });
    const gone = { path: "/repos/gone", name: "gone", added_at: "t" };

    const leases = liveLeases(
      () => [gone, shop.entry],
      (entry) => {
        if (entry === gone) throw new Error("no such repo");
        return shop.ctx;
      },
    );

    expect(leases).toEqual([{ project: "shop", runId: held.id, issue: 12, owner: "work-1-abc" }]);
  });
});
