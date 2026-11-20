import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../store/store.js";
import { atStartLimit, startLimit } from "./start-limit.js";

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");

/** A project with runs created at the given times, cancelling or rejecting the ones asked. */
function projectWithRuns(times: { at: number; state?: "cancelled" | "rejected" }[]) {
  const store = new Store(":memory:");
  const row = store.upsertProject({ name: "shop", repo_path: "/repos/shop", github_repo: "acme/shop" });
  vi.useFakeTimers({ toFake: ["Date"] });
  times.forEach(({ at, state }, i) => {
    vi.setSystemTime(at);
    const run = store.createRun({ project_id: row.id, title: `Run ${i}`, issue_number: i + 1 });
    if (state) store.writeState(run.id, state);
  });
  vi.useRealTimers();
  return { store, id: row.id };
}

afterEach(() => vi.useRealTimers());

describe("startLimit", () => {
  it("is under the limit with fewer starts than allowed", () => {
    const { store, id } = projectWithRuns([{ at: NOW - HOUR }]);
    const limit = startLimit(store, id, 2, NOW);

    expect(limit).toEqual({ started: 1, max: 2 });
    expect(atStartLimit(limit)).toBe(false);
  });

  it("at the limit, says the next start is when the oldest run in the window turns 24 hours old", () => {
    const { store, id } = projectWithRuns([{ at: NOW - 3 * HOUR }, { at: NOW - 10 * HOUR }]);
    const limit = startLimit(store, id, 2, NOW);

    expect(limit).toEqual({ started: 2, max: 2, nextStartAt: new Date(NOW + 14 * HOUR).toISOString() });
    expect(atStartLimit(limit)).toBe(true);
  });

  it("counts a run for exactly 24 hours", () => {
    const { store, id } = projectWithRuns([{ at: NOW - 24 * HOUR }, { at: NOW - 24 * HOUR + 1 }]);

    expect(startLimit(store, id, 5, NOW).started).toBe(1);
  });

  it("counts cancelled and rejected runs: they were started", () => {
    const { store, id } = projectWithRuns([{ at: NOW - HOUR, state: "cancelled" }, { at: NOW - 2 * HOUR, state: "rejected" }]);

    expect(startLimit(store, id, 2, NOW)).toMatchObject({ started: 2, nextStartAt: new Date(NOW + 22 * HOUR).toISOString() });
  });

  it("with the limit lowered below what started, waits until enough runs have aged out", () => {
    const { store, id } = projectWithRuns([{ at: NOW - 20 * HOUR }, { at: NOW - 5 * HOUR }, { at: NOW - HOUR }]);

    // 3 started, 2 allowed: to start one more, two must age out, so the second oldest decides.
    expect(startLimit(store, id, 2, NOW).nextStartAt).toBe(new Date(NOW + 19 * HOUR).toISOString());
  });

  it("with 0 allowed, starts nothing and gives no time", () => {
    const { store, id } = projectWithRuns([]);
    const limit = startLimit(store, id, 0, NOW);

    expect(limit).toEqual({ started: 0, max: 0 });
    expect(atStartLimit(limit)).toBe(true);
  });
});
