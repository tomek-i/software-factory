import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { bumpy, lastMove, learnConfig as config, learned, LESSON, setup } from "../../test/driver-setup.js";
import { RunMachine } from "./transitions.js";

/** The PR is merged by the time a run learns, so nothing that goes wrong there may hold the run up. */
describe("PipelineDriver learn stage when something goes wrong", () => {
  it("never holds up a merged run: a failed learner only skips the lessons, with a warning", async () => {
    const { driver, store, seen } = setup(bumpy({ stream: "error_max_turns" }), { config: config() });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({ from_state: "learn", to_state: "done", reason: expect.stringMatching(/^lessons skipped: learner agent failed/) });
    expect(seen).toContainEqual(expect.objectContaining({ type: "info", message: expect.stringMatching(/^warning: no lessons from this run: learner agent failed/) }));
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

  it("sends a merged run to done, not to a human, on any unexpected error while learning", async () => {
    const { driver, store } = setup(bumpy(), { config: config() });
    vi.spyOn(driver as unknown as { learn: () => Promise<unknown> }, "learn").mockRejectedValue(new Error("boom"));
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({ from_state: "learn", to_state: "done", reason: "lessons skipped: error: boom" });
  });

  it("stores nothing when the run is cancelled while the learner runs", async () => {
    const { driver, store } = setup(bumpy({ output: learned([LESSON]), sleepMs: 4000 }), { config: config() });
    const run = driver.startRun(12);
    const watch = setInterval(() => {
      if (store.listAgentRuns(run.id).some((a) => a.role === "learner" && a.status === "running")) {
        clearInterval(watch);
        new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(run.id, "stop");
      }
    }, 50);

    try {
      expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "cancelled" });
    } finally {
      clearInterval(watch);
    }
    expect(store.listEvents(run.id).map((e) => e.to_state)).not.toContain("done");
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

});
