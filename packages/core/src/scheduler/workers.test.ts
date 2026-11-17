import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { tempDir } from "../../test/helpers.js";
import { ServiceError } from "../service/errors.js";
import type { ProjectContext } from "../service/project.js";
import { Store } from "../store/store.js";
import { asWorker, liveLeases, liveWorkers, registerWorker, takeUpgradeLock, upgradeLockPath, workersDir } from "./workers.js";

const MINUTE = 60_000;
// A pid that is alive but not this process's: the test runner that started this worker.
const OTHER = process.ppid;

describe("worker presence", () => {
  it("lives in the factory's data folder", () => {
    expect(workersDir({ FACTORY_DATA_DIR: "/data" })).toBe(join("/data", "workers"));
    expect(upgradeLockPath({ FACTORY_DATA_DIR: "/data" })).toBe(join("/data", "upgrading.json"));
  });

  it("lists a registered worker until it unregisters, leaving no temp file behind", () => {
    const dir = join(tempDir(), "workers");
    expect(liveWorkers(dir)).toEqual([]);

    const unregister = registerWorker(dir, 4242);
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^4242-[0-9a-f]+\.json$/)]);
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

  it("is refused while a live upgrade holds the lock, and leaves no file then", () => {
    const dir = join(tempDir(), "workers");
    const lock = join(tempDir(), "upgrading.json");
    const release = takeUpgradeLock(lock, OTHER);

    expect(() => registerWorker(dir, 4242, lock)).toThrow(/`factory upgrade` is replacing the factory \(pid \d+\)/);
    expect(readdirSync(dir)).toEqual([]);

    release();
    expect(existsSync(lock)).toBe(false);
    registerWorker(dir, 4242, lock)();
  });
});

describe("the upgrade lock", () => {
  it("is refused while another live upgrade holds it", () => {
    const lock = join(tempDir(), "upgrading.json");
    takeUpgradeLock(lock, OTHER);

    expect(() => takeUpgradeLock(lock)).toThrow(/Another `factory upgrade` is running/);
  });

  it("is taken over from an upgrade that died", () => {
    const lock = join(tempDir(), "upgrading.json");
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 30 }));

    const release = takeUpgradeLock(lock);
    expect(existsSync(lock)).toBe(true);
    release();
    expect(existsSync(lock)).toBe(false);
  });
});

describe("asWorker", () => {
  it("is registered before the work starts and unregistered when it ends", async () => {
    let during: string[] = [];

    await asWorker(async () => {
      during = readdirSync(workersDir());
      return { interrupted: false };
    });

    expect(during).toHaveLength(1);
    expect(readdirSync(workersDir())).toEqual([]);
  });

  it("unregisters when the work throws", async () => {
    await expect(asWorker(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(readdirSync(workersDir())).toEqual([]);
  });

  it("stays registered until the process exits after an interrupt, when drives are left behind", async () => {
    let unregistered = 0;
    const exitListeners = process.listenerCount("exit");

    await asWorker(
      async () => ({ interrupted: true }),
      () => () => unregistered++,
    );

    expect(unregistered).toBe(0);
    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    process.emit("exit", 0);
    expect(unregistered).toBe(1);
  });
});

describe("liveLeases", () => {
  function project(name: string) {
    const store = new Store(":memory:");
    const row = store.upsertProject({ name, repo_path: `/repos/${name}`, github_repo: `acme/${name}` });
    const ctx: ProjectContext = { root: row.repo_path, config: factoryConfigSchema.parse({ version: 1 }), store, project: row };
    return { store, row, ctx, entry: { path: row.repo_path, name, added_at: "t" } };
  }

  it("lists runs with an unexpired lease, and skips expired ones and projects not set up", () => {
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
        if (entry === gone) throw new ServiceError("The repository /repos/gone no longer exists.");
        return shop.ctx;
      },
    );

    expect(leases).toEqual([{ project: "shop", runId: held.id, issue: 12, owner: "work-1-abc" }]);
  });

  it("ignores parked and finished runs that still carry a lease", () => {
    const shop = project("shop");
    for (const state of ["needs_human", "done"] as const) {
      const run = shop.store.createRun({ project_id: shop.row.id, title: state, issue_number: 1 });
      shop.store.acquireLease(run.id, "work-1-abc", 15 * MINUTE);
      shop.store.writeState(run.id, state);
    }

    expect(liveLeases(() => [shop.entry], () => shop.ctx)).toEqual([]);
  });

  it("throws when a project fails to open for another reason, since a run might be going on there", () => {
    const shop = project("shop");

    expect(() =>
      liveLeases(
        () => [shop.entry],
        () => {
          throw new Error("database is locked");
        },
      ),
    ).toThrow("database is locked");
  });
});
