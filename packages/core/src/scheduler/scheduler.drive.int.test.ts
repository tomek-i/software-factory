import { describe, expect, it } from "vitest";
import { setup, TRIAGE } from "../../test/driver-setup.js";
import { loadConfig } from "../config/load.js";
import { Scheduler, type SchedulerEvent } from "./scheduler.js";

const HUMAN_TRIAGE = "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";

describe("Scheduler with the real driveIssue", () => {
  it("drives a queued issue as factory run does, and gives the lease back", async () => {
    const s = setup([{ output: TRIAGE() }], { config: HUMAN_TRIAGE });
    const ctx = { root: s.root, config: loadConfig(s.root), store: s.store, project: s.project };
    const events: SchedulerEvent[] = [];
    const scheduler = new Scheduler({
      owner: "work-test",
      projects: () => [{ path: s.root, name: "demo", added_at: "t" }],
      open: () => ctx,
      fetchIssue: () => {},
      env: s.fake.env,
      github: () => s.github,
      onEvent: (e) => {
        events.push(e);
        // One run is enough: stop once it has come back.
        if (e.type === "finished") scheduler.drain();
      },
      tickMs: 10,
    });

    await expect(scheduler.run()).resolves.toBe("drained");

    const finished = events.find((e) => e.type === "finished");
    expect(finished).toMatchObject({ issue: 12, outcome: { kind: "parked", state: "needs_human" } });
    const [run] = s.store.listRuns({ project_id: s.project.id });
    expect(run).toMatchObject({ state: "needs_human", lease_owner: null });
    expect(events.some((e) => e.type === "run" && e.event.type === "agent:start")).toBe(true);
  });
});
