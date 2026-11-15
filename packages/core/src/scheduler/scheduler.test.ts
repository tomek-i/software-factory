import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema, isTerminal, type FactoryConfigInput, type RunState } from "@factory/shared";
import type { DriveOutcome } from "../pipeline/driver.js";
import type { ProjectContext } from "../service/project.js";
import type { DriveOptions } from "../service/runs.js";
import { Store, type Run } from "../store/store.js";
import { Scheduler, type DriveFn, type SchedulerEvent, type SchedulerOptions } from "./scheduler.js";
import type { StopRequest } from "./stop.js";

const MINUTE = 60_000;

interface Drive {
  project: string;
  issue: number;
  options: DriveOptions;
  run: Run;
  stop: ReturnType<typeof vi.fn>;
  finish(outcome?: DriveOutcome, state?: RunState): Promise<void>;
  fail(error: Error): Promise<void>;
}

/** A drive that starts or picks up the issue's run, holds its lease, and ends when the test says so. */
function fakeDrive() {
  const drives: Drive[] = [];
  const drive: DriveFn = (ctx, number, options, deps) =>
    new Promise((resolve, reject) => {
      const { store, project } = ctx;
      const existing = store.listRuns({ project_id: project.id }).find((r) => r.issue_number === number && !isTerminal(r.state));
      const run = existing ?? store.createRun({ project_id: project.id, title: `Issue ${number}`, issue_number: number });
      store.acquireLease(run.id, deps.owner, 15 * MINUTE);
      const stop = vi.fn(() => store.releaseLease(run.id, deps.owner));
      deps.onNotice?.({ type: "started", run, issue: store.getIssue(project.id, number)!, stop });
      // Let the scheduler's promise chain run, so a finished drive frees its slot before the next tick.
      const settle = () => new Promise<void>((r) => setTimeout(r, 0));
      drives.push({
        project: project.name,
        issue: number,
        options,
        run,
        stop,
        finish: async (outcome = { kind: "parked", state: "needs_human", reason: "gate" }, state) => {
          // Parked and finished runs move on, as a real drive leaves them.
          const target = state ?? (outcome.kind === "parked" || outcome.kind === "finished" ? outcome.state : undefined);
          if (target) store.writeState(run.id, target);
          store.releaseLease(run.id, deps.owner);
          resolve({ outcome, run: store.getRun(run.id)! });
          await settle();
        },
        fail: async (error) => {
          store.releaseLease(run.id, deps.owner);
          reject(error);
          await settle();
        },
      });
    });
  return { drive, drives, issues: () => drives.map((d) => d.issue) };
}

function project(name: string, config: FactoryConfigInput = { version: 1 }) {
  const store = new Store(":memory:");
  const row = store.upsertProject({ name, repo_path: `/repos/${name}`, github_repo: `acme/${name}` });
  const ctx: ProjectContext = { root: row.repo_path, config: factoryConfigSchema.parse({ version: 1 }), store, project: row };
  const trusted = factoryConfigSchema.parse(config);
  const queue = (...numbers: number[]) => {
    for (const number of numbers) {
      store.upsertIssue(row.id, { number, title: `Issue ${number}`, body: "", state: "open", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
      store.setQueued(row.id, number, true);
    }
  };
  return { name, store, row, ctx, trusted, queue, entry: { path: row.repo_path, name, added_at: "t" } };
}

type Project = ReturnType<typeof project>;

function scheduler(projects: Project[], overrides: Partial<SchedulerOptions> = {}) {
  const fake = fakeDrive();
  let clock = Date.now();
  let stop: StopRequest | undefined;
  const events: SchedulerEvent[] = [];
  const fetched: number[] = [];
  const s = new Scheduler({
    owner: "work-test",
    projects: () => projects.map((p) => p.entry),
    open: (entry) => projects.find((p) => p.entry.path === entry.path)!.ctx,
    trustedConfig: (ctx) => projects.find((p) => p.ctx === ctx)!.trusted,
    fetchIssue: (_ctx, n) => void fetched.push(n),
    drive: fake.drive,
    now: () => clock,
    stopRequest: () => stop,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return {
    s,
    ...fake,
    events,
    fetched,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    requestStop: (now = false) => (stop = { at: clock + 1, now }),
  };
}

describe("Scheduler: starting queued issues", () => {
  it("starts queued issues in queue order, and a third when a slot frees", async () => {
    const shop = project("shop");
    shop.queue(7, 3, 9);
    const t = scheduler([shop], { maxRuns: 2 });

    t.s.tick();
    expect(t.issues()).toEqual([7, 3]);
    expect(t.fetched).toEqual([7, 3]);
    expect(t.drives[0]!.options).toEqual({ runId: undefined, retriage: false });

    t.s.tick();
    expect(t.issues()).toEqual([7, 3]);

    await t.drives[0]!.finish();
    t.s.tick();
    expect(t.issues()).toEqual([7, 3, 9]);
    expect(t.events.filter((e) => e.type === "started").map((e) => e.type === "started" && e.recovered)).toEqual([false, false, false]);
  });

  it("holds the project's max_runs, counting runs other processes hold", () => {
    const shop = project("shop", { version: 1, concurrency: { max_runs: 2 } });
    shop.queue(1, 2, 3);
    const elsewhere = shop.store.createRun({ project_id: shop.row.id, title: "x", issue_number: 1 });
    shop.store.acquireLease(elsewhere.id, "cli-42", 15 * MINUTE);
    const t = scheduler([shop]);

    t.s.tick();

    expect(t.issues()).toEqual([2]);
  });

  it("holds the worker's own limit across projects", () => {
    const a = project("a");
    const b = project("b");
    a.queue(1, 2);
    b.queue(5);
    const t = scheduler([a, b], { maxRuns: 2 });

    t.s.tick();

    expect(t.drives).toHaveLength(2);
    expect(t.s.status().running).toHaveLength(2);
  });

  it("starts no more than max_starts_per_day in 24 hours, and none with 0", async () => {
    const shop = project("shop", { version: 1, github: { max_starts_per_day: 2 } });
    const none = project("none", { version: 1, github: { max_starts_per_day: 0 } });
    shop.queue(1, 2, 3);
    none.queue(1);
    const t = scheduler([shop, none]);

    t.s.tick();
    await t.drives[0]!.finish();
    t.s.tick();

    expect(t.drives.map((d) => `${d.project}#${d.issue}`)).toEqual(["shop#1", "shop#2"]);
  });

  it("doesn't start an issue unqueued before its turn, or closed on GitHub", () => {
    const shop = project("shop");
    shop.queue(1, 2, 3);
    shop.store.setQueued(shop.row.id, 1, false);
    const t = scheduler([shop], {
      // What fetchIssue does when GitHub says the issue was closed.
      fetchIssue: (ctx, n) => {
        if (n === 2) ctx.store.upsertIssue(ctx.project.id, { number: 2, title: "Issue 2", body: "", state: "closed", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-02T00:00:00Z" });
      },
    });

    t.s.tick();

    expect(t.issues()).toEqual([3]);
  });

  it("doesn't start an issue again after its run ended, until it is queued again", async () => {
    const shop = project("shop");
    shop.queue(1);
    const t = scheduler([shop]);

    t.s.tick();
    await t.drives[0]!.finish({ kind: "finished", state: "failed" }, "failed");
    t.s.tick();
    expect(t.issues()).toEqual([1]);

    shop.store.setQueued(shop.row.id, 1, false);
    shop.store.setQueued(shop.row.id, 1, true);
    // Queued again after the failed run; the same millisecond would count as before it.
    shop.store.db.prepare("UPDATE issues SET queued_at = ? WHERE number = 1").run(new Date(Date.now() + 1000).toISOString());
    t.s.tick();
    expect(t.issues()).toEqual([1, 1]);
  });

  it("skips an issue it can't fetch, says why, and leaves it for a while", () => {
    const shop = project("shop");
    shop.queue(1);
    const t = scheduler([shop], {
      fetchIssue: () => {
        throw new Error("gh: HTTP 502\ndetails");
      },
    });

    t.s.tick();
    t.s.tick();

    expect(t.issues()).toEqual([]);
    expect(t.events.filter((e) => e.type === "skipped")).toEqual([{ type: "skipped", project: "shop", issue: 1, reason: "could not fetch it: gh: HTTP 502" }]);
  });

  it("reports a project that doesn't open once, and goes on with the others", () => {
    const shop = project("shop");
    const gone = project("gone");
    shop.queue(1);
    const t = scheduler([gone, shop], {
      open: (entry) => {
        if (entry.name === "gone") throw new Error("The repository /repos/gone no longer exists.");
        return shop.ctx;
      },
    });

    t.s.tick();
    t.s.tick();

    expect(t.issues()).toEqual([1]);
    expect(t.events.filter((e) => e.type === "skipped")).toHaveLength(1);
  });
});

describe("Scheduler: recovery", () => {
  function stuck(p: Project, issue: number, state: RunState, lease?: { owner: string; ttlMs: number }) {
    p.queue(issue);
    const run = p.store.createRun({ project_id: p.row.id, title: `Issue ${issue}`, issue_number: issue });
    p.store.writeState(run.id, state);
    if (lease) p.store.acquireLease(run.id, lease.owner, lease.ttlMs);
    return run;
  }

  it("continues a run whose worker died once its lease expired, but not one a live worker holds", () => {
    const shop = project("shop");
    const dead = stuck(shop, 1, "build", { owner: "cli-1", ttlMs: -1 });
    stuck(shop, 2, "review", { owner: "cli-2", ttlMs: 15 * MINUTE });
    const t = scheduler([shop]);

    t.s.tick();

    expect(t.drives.map((d) => d.run.id)).toEqual([dead.id]);
    // That exact run, never a new one, and never sent back to triage.
    expect(t.drives[0]!.options).toEqual({ runId: dead.id, retriage: false });
    expect(t.events.find((e) => e.type === "started")).toMatchObject({ recovered: true, issue: 1 });
    // Fetched first, like a new start: an issue closed on GitHub stops being worked on.
    expect(t.fetched).toEqual([1]);
  });

  it("never continues a run started with --unsafe, which was meant for someone watching", () => {
    const shop = project("shop");
    shop.queue(1);
    shop.store.createRun({ project_id: shop.row.id, title: "Issue 1", issue_number: 1, unsafe: true });
    const t = scheduler([shop]);

    t.s.tick();

    expect(t.drives).toEqual([]);
  });

  it("never picks up a run waiting for a human or for information", () => {
    const shop = project("shop");
    stuck(shop, 1, "needs_human");
    stuck(shop, 2, "needs_info");
    const t = scheduler([shop]);

    t.s.tick();

    expect(t.drives).toEqual([]);
  });

  it("doesn't continue a run whose issue was unqueued", () => {
    const shop = project("shop");
    stuck(shop, 1, "build");
    shop.store.setQueued(shop.row.id, 1, false);
    const t = scheduler([shop]);

    t.s.tick();

    expect(t.drives).toEqual([]);
  });

  it("continues stopped runs before starting new issues", () => {
    const shop = project("shop");
    shop.queue(1);
    stuck(shop, 2, "build");
    const t = scheduler([shop], { maxRuns: 1 });

    t.s.tick();

    expect(t.issues()).toEqual([2]);
    expect(t.drives[0]!.options.runId).toBeDefined();
  });

  it("leaves a run that comes back stopped alone for a while, instead of spinning on it", async () => {
    const shop = project("shop");
    stuck(shop, 1, "build");
    const t = scheduler([shop]);

    t.s.tick();
    await t.drives[0]!.finish({ kind: "stopped", state: "build", reason: "the build stage is not automated yet" });
    t.s.tick();
    expect(t.drives).toHaveLength(1);

    t.advance(31 * MINUTE);
    t.s.tick();
    expect(t.drives).toHaveLength(2);
  });

  it("leaves a run whose drive threw alone for a while, and reports it", async () => {
    const shop = project("shop");
    stuck(shop, 1, "build");
    const t = scheduler([shop]);

    t.s.tick();
    await t.drives[0]!.fail(new Error("boom"));
    t.s.tick();

    expect(t.drives).toHaveLength(1);
    expect(t.events.find((e) => e.type === "failed")).toMatchObject({ issue: 1, error: "boom" });
  });
});

describe("Scheduler: usage limit", () => {
  it("starts nothing until the limit resets, then continues the stopped run first", async () => {
    const shop = project("shop");
    shop.queue(1, 2);
    const t = scheduler([shop], { maxRuns: 1 });
    const resetsAt = new Date(t.now() + 2 * 60 * MINUTE).toISOString();

    t.s.tick();
    await t.drives[0]!.finish({ kind: "rate_limited", resetsAt });
    expect(t.s.status().pausedUntil).toBe(resetsAt);
    expect(t.events).toContainEqual({ type: "paused", until: resetsAt });

    t.advance(119 * MINUTE);
    t.s.tick();
    expect(t.issues()).toEqual([1]);

    t.advance(2 * MINUTE);
    t.s.tick();
    expect(t.events).toContainEqual({ type: "resumed" });
    expect(t.issues()).toEqual([1, 1]);
    expect(t.drives[1]!.run.id).toBe(t.drives[0]!.run.id);
  });

  it("waits 30 minutes when the agent didn't say when the limit resets", async () => {
    const shop = project("shop");
    shop.queue(1);
    const t = scheduler([shop]);

    t.s.tick();
    await t.drives[0]!.finish({ kind: "rate_limited" });

    expect(t.s.status().pausedUntil).toBe(new Date(t.now() + 30 * MINUTE).toISOString());
    t.advance(29 * MINUTE);
    t.s.tick();
    expect(t.drives).toHaveLength(1);
    t.advance(MINUTE);
    t.s.tick();
    expect(t.drives).toHaveLength(2);
  });
});

describe("Scheduler: errors", () => {
  it("survives a tick that throws, says why, and tries again next time", () => {
    const shop = project("shop");
    shop.queue(1);
    let broken = true;
    const t = scheduler([shop], {
      projects: () => {
        if (broken) throw new Error("The project list is not valid");
        return [shop.entry];
      },
    });

    expect(() => t.s.tick()).not.toThrow();
    expect(t.events).toContainEqual({ type: "error", message: "The project list is not valid" });
    broken = false;
    t.s.tick();
    expect(t.issues()).toEqual([1]);
  });

  it("reports a drive that throws before it starts, and carries on", () => {
    const shop = project("shop");
    shop.queue(1, 2);
    const t = scheduler([shop], {
      drive: () => {
        throw new Error("sync boom");
      },
    });

    expect(() => t.s.tick()).not.toThrow();
    return new Promise<void>((done) =>
      setTimeout(() => {
        expect(t.events.filter((e) => e.type === "failed").map((e) => e.type === "failed" && e.error)).toEqual(["sync boom", "sync boom"]);
        expect(t.s.status().running).toEqual([]);
        done();
      }, 0),
    );
  });
});

describe("Scheduler: stopping", () => {
  it("on a stop request, starts nothing more and finishes when its runs are done", async () => {
    const shop = project("shop");
    shop.queue(1, 2);
    const t = scheduler([shop], { maxRuns: 1, tickMs: 5 });

    const result = t.s.run();
    expect(t.issues()).toEqual([1]);
    t.requestStop();
    t.s.tick();
    expect(t.s.status().stopping).toBe("drain");
    await t.drives[0]!.finish();

    await expect(result).resolves.toBe("drained");
    expect(t.issues()).toEqual([1]);
    expect(t.events).toContainEqual({ type: "stopping", now: false, interrupted: 0 });
  });

  it("on a stop --now request, interrupts its runs and leaves no lease held", async () => {
    const shop = project("shop");
    shop.queue(1, 2);
    const t = scheduler([shop], { tickMs: 5 });

    const result = t.s.run();
    expect(t.issues()).toEqual([1, 2]);
    t.requestStop(true);

    await expect(result).resolves.toBe("interrupted");
    expect(t.drives.map((d) => d.stop.mock.calls.length)).toEqual([1, 1]);
    expect(shop.store.listRuns().map((r) => r.lease_owner)).toEqual([null, null]);
    expect(t.events).toContainEqual({ type: "stopping", now: true, interrupted: 2 });
  });

  it("obeys a stop request made after the given start time, even before it was created", () => {
    const shop = project("shop");
    shop.queue(1);
    const startedAt = Date.now() - MINUTE;
    const t = scheduler([shop], { startedAt, stopRequest: () => ({ at: startedAt + 1, now: false }) });

    t.s.tick();

    expect(t.drives).toEqual([]);
    expect(t.s.status().stopping).toBe("drain");
  });

  it("ignores a stop request from before it started", () => {
    const shop = project("shop");
    shop.queue(1);
    const t = scheduler([shop], { stopRequest: () => ({ at: Date.now() - MINUTE, now: true }) });

    t.s.tick();

    expect(t.issues()).toEqual([1]);
    expect(t.s.status().stopping).toBeUndefined();
  });

  it("interrupts its runs when the signal aborts", async () => {
    const shop = project("shop");
    shop.queue(1);
    const t = scheduler([shop], { tickMs: 60_000 });
    const controller = new AbortController();

    const result = t.s.run(controller.signal);
    controller.abort();

    await expect(result).resolves.toBe("interrupted");
    expect(t.drives[0]!.stop).toHaveBeenCalledOnce();
  });
});
