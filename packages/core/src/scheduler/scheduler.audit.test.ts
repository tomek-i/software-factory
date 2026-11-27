import { describe, expect, it } from "vitest";
import { factoryConfigSchema, type FactoryConfigInput } from "@factory/shared";
import type { AuditRecord } from "../security/audit.js";
import type { ProjectContext } from "../service/project.js";
import { Store } from "../store/store.js";
import { Scheduler, type DriveFn, type SchedulerEvent, type SchedulerOptions } from "./scheduler.js";
import type { StopRequest } from "./stop.js";

const DAY = 24 * 60 * 60_000;

function project(name: string, config: FactoryConfigInput = { version: 1, security: { audit_schedule: "weekly" } }) {
  const store = new Store(":memory:");
  const row = store.upsertProject({ name, repo_path: `/repos/${name}`, github_repo: `acme/${name}` });
  const ctx: ProjectContext = { root: row.repo_path, config: factoryConfigSchema.parse({ version: 1 }), store, project: row };
  const queue = (number: number) => {
    store.upsertIssue(row.id, { number, title: `Issue ${number}`, body: "", state: "open", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
    store.setQueued(row.id, number, true);
  };
  return { name, store, row, ctx, trusted: factoryConfigSchema.parse(config), queue, entry: { path: row.repo_path, name, added_at: "t" }, past: [] as Pick<AuditRecord, "status" | "started_at">[] };
}

type Project = ReturnType<typeof project>;

interface PendingAudit {
  project: string;
  signal: AbortSignal;
  finish(status?: AuditRecord["status"]): Promise<void>;
  fail(error: Error): Promise<void>;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function scheduler(projects: Project[], overrides: Partial<SchedulerOptions> = {}) {
  let clock = Date.parse("2026-11-27T10:00:00Z");
  let stop: StopRequest | undefined;
  const events: SchedulerEvent[] = [];
  const audits: PendingAudit[] = [];
  const drives: number[] = [];
  // Drives that never finish: they only hold slots.
  const drive: DriveFn = (ctx, number, _options, deps) => {
    drives.push(number);
    const run = ctx.store.createRun({ project_id: ctx.project.id, title: `Issue ${number}`, issue_number: number });
    deps.onNotice?.({ type: "started", run, issue: ctx.store.getIssue(ctx.project.id, number)!, stop: () => {} });
    return new Promise(() => {});
  };
  const s = new Scheduler({
    owner: "work-test",
    projects: () => projects.map((p) => p.entry),
    open: (entry) => projects.find((p) => p.entry.path === entry.path)!.ctx,
    trustedConfig: (ctx) => projects.find((p) => p.ctx === ctx)!.trusted,
    fetchIssue: () => {},
    drive,
    audits: (ctx) => projects.find((p) => p.ctx === ctx)!.past,
    audit: (ctx, signal) =>
      new Promise((resolve, reject) => {
        const p = projects.find((x) => x.ctx === ctx)!;
        const record = (status: AuditRecord["status"]): AuditRecord => ({ id: "a", started_at: new Date(clock).toISOString(), finished_at: "", commit: "c", effort: "medium", status, findings: [], notes: [], filed: {} });
        // Like runAudit: an abort ends it as cancelled.
        signal.addEventListener("abort", () => resolve(record("cancelled")));
        audits.push({
          project: p.name,
          signal,
          finish: async (status = "complete") => {
            p.past.push(record(status));
            resolve(record(status));
            await settle();
          },
          fail: async (error) => {
            reject(error);
            await settle();
          },
        });
      }),
    now: () => clock,
    stopRequest: () => stop,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { s, events, audits, drives, advance: (ms: number) => (clock += ms), requestStop: (now = false) => (stop = { at: clock + 1, now }) };
}

describe("Scheduler: audits", () => {
  it("runs a due audit once, in a slot of its own, and again when the next one is due", async () => {
    const shop = project("shop");
    const t = scheduler([shop]);
    t.s.tick();
    t.s.tick();
    expect(t.audits.map((a) => a.project)).toEqual(["shop"]);
    expect(t.s.status().audits).toEqual([{ project: "shop", path: "/repos/shop", state: "running" }]);
    expect(t.events).toContainEqual({ type: "audit_started", project: "shop" });

    await t.audits[0]!.finish();
    expect(t.events).toContainEqual({ type: "audit_finished", project: "shop", status: "complete", findings: 0 });
    expect(t.s.status().audits).toEqual([]);
    t.s.tick();
    expect(t.audits).toHaveLength(1);

    t.advance(7 * DAY);
    t.s.tick();
    expect(t.audits).toHaveLength(2);
  });

  it("leaves projects alone whose schedule is off or whose last audit is recent", () => {
    const off = project("off", { version: 1 });
    const recent = project("recent");
    recent.past.push({ status: "skipped", started_at: "2026-11-26T10:00:00Z" });
    const t = scheduler([off, recent]);
    t.s.tick();
    expect(t.audits).toEqual([]);
  });

  it("gives the slots to runs first, and runs one audit at a time outside the project's run limit", async () => {
    const shop = project("shop", { version: 1, security: { audit_schedule: "weekly" }, concurrency: { max_runs: 1 } });
    shop.queue(7);
    const t = scheduler([shop], { maxRuns: 2 });
    t.s.tick();
    // The run took the project's only run slot; the audit isn't a run on its worktrees.
    expect(t.drives).toEqual([7]);
    expect(t.audits.map((a) => a.project)).toEqual(["shop"]);

    const other = project("other");
    other.queue(8);
    other.queue(9);
    const u = scheduler([other], { maxRuns: 2 });
    u.s.tick();
    expect(u.drives).toEqual([8, 9]);
    expect(u.audits).toEqual([]);

    // Three projects due and three slots: one audit, so queued issues aren't kept waiting hours.
    const [a, b, c] = [project("a"), project("b"), project("c")];
    const v = scheduler([a, b, c], { maxRuns: 3 });
    v.s.tick();
    expect(v.audits.map((x) => x.project)).toEqual(["a"]);
    await v.audits[0]!.finish();
    v.s.tick();
    expect(v.audits.map((x) => x.project)).toEqual(["a", "b"]);
  });

  it("reads an idle project's schedule at most hourly, and not while a recent audit says none is due", () => {
    const off = project("off", { version: 1 });
    const recent = project("recent");
    recent.past.push({ status: "complete", started_at: "2026-11-26T10:00:00Z" });
    const reads: string[] = [];
    const t = scheduler([off, recent], {
      trustedConfig: (ctx) => {
        const p = [off, recent].find((x) => x.ctx === ctx)!;
        reads.push(p.name);
        return p.trusted;
      },
    });
    for (let i = 0; i < 12; i++) {
      t.s.tick();
      t.advance(5 * 60_000);
    }
    // Each read fetches the default branch: once in the hour for the project never audited.
    expect(reads).toEqual(["off"]);
    t.s.tick();
    expect(reads).toEqual(["off", "off"]);
    expect(t.audits).toEqual([]);
  });

  it("leaves a project alone that another process is auditing", () => {
    const shop = project("shop");
    shop.past.push({ status: "running", started_at: "2026-11-27T09:00:00Z" });
    const t = scheduler([shop]);
    t.s.tick();
    expect(t.audits).toEqual([]);

    expect(t.s.requestAudit("/repos/shop", "shop")).toBeUndefined();
    t.s.tick();
    expect(t.audits).toEqual([]);
    expect(t.s.status().audits).toEqual([{ project: "shop", path: "/repos/shop", state: "failed", error: "another process is auditing it" }]);
  });

  it("runs an audit asked for now, whatever the schedule, once, and says why it can't", async () => {
    const off = project("off", { version: 1 });
    const t = scheduler([off]);
    expect(t.s.requestAudit("/repos/off", "off")).toBeUndefined();
    expect(t.s.status().audits).toEqual([{ project: "off", path: "/repos/off", state: "requested" }]);
    expect(t.s.requestAudit("/repos/off", "off")).toBe("An audit of this project is already waiting for a free slot.");
    t.s.tick();
    expect(t.audits).toHaveLength(1);
    expect(t.s.requestAudit("/repos/off", "off")).toBe("An audit of this project is already going on.");
    await t.audits[0]!.finish();
    t.s.tick();
    expect(t.audits).toHaveLength(1);
  });

  it("drops a request it can't act on rather than showing it as waiting for good", () => {
    const broken = project("broken");
    const t = scheduler([broken], {
      trustedConfig: () => {
        throw new Error("fatal: couldn't find remote ref main");
      },
    });
    t.s.requestAudit("/repos/broken", "broken");
    t.s.tick();
    expect(t.audits).toEqual([]);
    expect(t.s.status().audits).toEqual([
      { project: "broken", path: "/repos/broken", state: "failed", error: "could not read its config from the default branch: fatal: couldn't find remote ref main" },
    ]);

    // A project taken off the list.
    t.s.requestAudit("/repos/gone", "gone");
    t.s.tick();
    expect(t.s.status().audits.map((a) => a.path)).toEqual(["/repos/broken"]);
  });

  it("stops the audit on stop --now and on a drain, and waits for it before it resolves", async () => {
    const shop = project("shop");
    const t = scheduler([shop], { tickMs: 1 });
    t.s.tick();
    const done = t.s.run();
    // Only runs are counted: they are what can be continued.
    expect(t.s.stopNow()).toBe(0);
    expect(t.audits[0]!.signal.aborted).toBe(true);
    expect(await done).toBe("interrupted");
    expect(t.s.requestAudit("/repos/shop", "shop")).toBe("The worker is stopping, so it starts no audits.");

    const again = project("again");
    const u = scheduler([again], { tickMs: 1 });
    u.s.tick();
    u.requestStop();
    expect(await u.s.run()).toBe("drained");
    expect(u.audits[0]!.signal.aborted).toBe(true);
  });

  it("says when an audit couldn't start, waits before trying again, and lets a request skip the wait", async () => {
    const shop = project("shop");
    const t = scheduler([shop]);
    t.s.tick();
    await t.audits[0]!.fail(new Error("git fetch failed: offline"));
    expect(t.events).toContainEqual({ type: "audit_failed", project: "shop", error: "git fetch failed: offline" });
    expect(t.s.status().audits).toEqual([{ project: "shop", path: "/repos/shop", state: "failed", error: "git fetch failed: offline" }]);
    t.s.tick();
    expect(t.audits).toHaveLength(1);
    t.advance(31 * 60_000);
    t.s.tick();
    expect(t.audits).toHaveLength(2);
    expect(t.s.status().audits).toEqual([{ project: "shop", path: "/repos/shop", state: "running" }]);

    await t.audits[1]!.fail(new Error("git fetch failed: offline"));
    expect(t.s.requestAudit("/repos/shop", "shop")).toBeUndefined();
    t.s.tick();
    expect(t.audits).toHaveLength(3);
  });
});
