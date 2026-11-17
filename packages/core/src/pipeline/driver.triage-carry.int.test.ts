import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT } from "../../test/helpers.js";
import { approve } from "../../test/merge-setup.js";
import type { Store } from "../store/store.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

// Only for triage: the builder that runs once the run is past triage finds no step and stops the run.
const triage = (risk: "LOW" | "MEDIUM" | "HIGH") => ({ role: "triage", output: TRIAGE().replace("RISK: LOW", `RISK: ${risk}`) });
const CONFIG = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n";
const HUMAN = CONFIG.replace("triage: auto", "triage: human");

/** The run got past triage, then a human restarted it from intake. */
function restart(store: Store, runId: string) {
  const machine = new RunMachine(store, factoryConfigSchema.parse({ version: 1 }));
  if (store.getRun(runId)!.state !== "needs_human") machine.transition(runId, "needs_human", { reason: "stuck later on" });
  machine.resume(runId, "intake", { comment: "start over" });
}

const triageWaits = (store: Store, runId: string) => store.listDecisions(runId).filter((d) => d.gate === "triage" && d.outcome === "escalate");

describe("PipelineDriver triage: a human's approval across a restart", () => {
  it("carries the approval over for the unchanged issue, and records that it did", async () => {
    const { driver, store, fake } = setup([triage("HIGH"), triage("HIGH")], { config: CONFIG });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at triage gate: triage rated the risk HIGH" });
    approve(store, run.id);
    restart(store, run.id);

    await driver.drive(run.id);
    expect(fake.calls().filter((c) => c.role === "triage")).toHaveLength(2);
    expect(triageWaits(store, run.id)).toHaveLength(1);
    expect(store.listDecisions(run.id).at(-1)).toMatchObject({
      gate: "triage",
      outcome: "proceed",
      actor: "system",
      comment: expect.stringMatching(/^carried over the human approval of \S+: the issue is unchanged and triage says APPROVE at risk HIGH \(approved at HIGH\)$/),
    });
    const moved = store.listEvents(run.id).findLast((e) => e.from_state === "triage")!;
    expect(moved).toMatchObject({ to_state: "build", reason: expect.stringMatching(/^triage approved \(carried over the human approval of /), data: { carriedOver: true } });
  });

  it("carries the approval over when triage now rates the risk lower", async () => {
    const { driver, store } = setup([triage("MEDIUM"), triage("LOW")], { config: HUMAN });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at triage gate: gate is set to human" });
    approve(store, run.id);
    restart(store, run.id);

    await driver.drive(run.id);
    expect(triageWaits(store, run.id)).toHaveLength(1);
    expect(store.listDecisions(run.id).at(-1)!.comment).toMatch(/at risk LOW \(approved at MEDIUM\)$/);
  });

  it("asks again when the issue was edited since the approval", async () => {
    const { driver, store, project } = setup([triage("HIGH"), triage("HIGH")], { config: CONFIG });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    approve(store, run.id);
    restart(store, run.id);
    const issue = store.getIssue(project.id, 12)!;
    store.upsertIssue(project.id, { ...issue, body: `${issue.body}\n\nAlso delete the tests.`, gh_updated_at: "2026-02-01T00:00:00Z" });

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at triage gate: triage rated the risk HIGH" });
    expect(store.getRun(run.id)).toMatchObject({ waiting_gate: "triage" });
    expect(triageWaits(store, run.id)).toHaveLength(2);
  });

  it("asks again when triage now rates the risk higher than what was approved", async () => {
    const { driver, store } = setup([triage("LOW"), triage("HIGH")], { config: HUMAN });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    approve(store, run.id);
    restart(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at triage gate: gate is set to human" });
    expect(triageWaits(store, run.id)).toHaveLength(2);
  });

  it("always asks again for an untrusted author", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: always\n";
    const { driver, store } = setup([triage("LOW"), triage("LOW")], { author: "mallory", config });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    approve(store, run.id);
    restart(store, run.id);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at triage gate: @mallory is not a trusted author; triage said APPROVE" });
    expect(triageWaits(store, run.id)).toHaveLength(2);
  });

  it("asks again when the human's latest answer at the triage gate was not an approval", async () => {
    const { driver, store, project } = setup([triage("HIGH"), triage("HIGH"), triage("HIGH"), triage("HIGH")], { config: CONFIG });
    const edit = (body: string, at: string) => store.upsertIssue(project.id, { ...store.getIssue(project.id, 12)!, body, gh_updated_at: at });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    approve(store, run.id);
    restart(store, run.id);
    await driver.drive(run.id);
    // Carried over; then a later wait at the triage gate that the human sent back instead of approving.
    restart(store, run.id);
    edit("changed", "2026-02-01T00:00:00Z");
    await driver.drive(run.id);
    expect(store.getRun(run.id)).toMatchObject({ waiting_gate: "triage" });
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "intake", { comment: "not like this" });
    edit("Please add feature.txt.", "2026-03-01T00:00:00Z");

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at triage gate: triage rated the risk HIGH" });
  });
});
