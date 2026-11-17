import { describe, expect, it, vi } from "vitest";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT } from "../../test/helpers.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver quality gate timeouts", () => {
  it("waits for a human instead of sending the builder back when the only failure is a check timing out", async () => {
    const config =
      "version: 1\nchecks:\n  - name: slow\n    run: 'node -e \"setTimeout(() => {}, 60000)\"'\n    timeout_sec: 1\n    retries: 0\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }, buildStep("done")], { config });
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(outcome.kind === "parked" && outcome.reason).toBe(
      "quality gate timed out (round 1): slow ran past timeout_sec on every attempt; resume to gate to run it again, or to build if the code hangs",
    );
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "builder"]);
    expect(store.getRun(run.id)).toMatchObject({ parked_from: "gate", build_iterations: 0 });
  });

  it("still sends the builder back when a check fails outright next to one that timed out", async () => {
    const config =
      "version: 1\nchecks:\n  - name: slow\n    run: 'node -e \"setTimeout(() => {}, 60000)\"'\n    timeout_sec: 1\n    retries: 0\n  - name: broken\n    run: 'node -e \"process.exit(1)\"'\n    retries: 0\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\nloops:\n  max_build_iterations: 1\n";
    const { driver, fake } = setup([{ output: TRIAGE() }, buildStep("done"), buildStep("again")], { config });
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome.kind === "parked" && outcome.reason).toMatch(/^quality gate still failing after round 1/);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "builder"]);
  });
});
