import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, sameFailure, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT } from "../../test/helpers.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver", () => {
  it("keeps looping on different failures until max_build_iterations, then escalates", async () => {
    const config =
      "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: always\nloops:\n  max_build_iterations: 3\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }, buildStep("broken 1"), buildStep("broken 2"), buildStep("broken 3")], { config });
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(outcome.kind === "parked" && outcome.reason).toMatch(/still failing after round 3.*cap reached \(3\)/);
    expect(store.getRun(run.id)!.build_iterations).toBe(2);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "builder", "builder", "builder"]);
  });

  it("escalates a gate that fails the same way twice in a row, before the cap", async () => {
    const config =
      "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: always\nloops:\n  max_build_iterations: 5\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }, sameFailure(1), sameFailure(2), sameFailure(3), sameFailure(4)], { config });
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(outcome.kind === "parked" && outcome.reason).toBe(
      "stalled: quality gate failed the same way in rounds 1 and 2 (see round-1/checks.md and round-2/checks.md)",
    );
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "builder", "builder"]);
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "gate", build_iterations: 1 });

    // The loop event holds round 1's fingerprint; the escalation links both rounds to it.
    const events = store.listEvents(run.id);
    const loop = events.find((e) => e.from_state === "gate" && e.to_state === "build")!.data as { fingerprint: string; round: number };
    expect(loop).toMatchObject({ round: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(events.at(-1)!.data).toEqual({
      stalled: "quality gate",
      fingerprint: loop.fingerprint,
      rounds: [1, 2],
      files: ["round-1/checks.md", "round-2/checks.md"],
    });

    // A human grants another attempt: the next identical failure loops, the one after stalls again.
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "look at check.js" });
    const again = await driver.drive(run.id);

    expect(again.kind === "parked" && again.reason).toMatch(/^stalled: quality gate failed the same way in rounds 2 and 3 /);
    expect(fake.calls()).toHaveLength(5);
    expect(store.getRun(run.id)!.build_iterations).toBe(2);
  });
});
