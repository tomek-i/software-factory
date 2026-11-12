import { describe, expect, it, vi } from "vitest";
import { setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT } from "../../test/helpers.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver", () => {
  it("closes agent rows left running by a worker that died", async () => {
    const { driver, store, root } = setup([{ stream: "rate_limited" }]);
    const run = driver.startRun(12);
    const orphan = store.startAgentRun({ run_id: run.id, role: "triage", model: "opus", session_id: "s", log_dir: root });
    store.setAgentPid(orphan.id, 999999);

    await driver.drive(run.id);

    expect(store.getAgentRun(orphan.id)).toMatchObject({ status: "error", pid: null });
  });

  it("triages again after the author was asked for information", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { driver, store } = setup([{ output: TRIAGE("NEEDS_INFO", "\n## Questions\n- Which format?\n") }, { output: TRIAGE() }], { config });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    expect(store.getRun(run.id)!.state).toBe("needs_info");

    driver.retriage(run.id);
    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(store.getRun(run.id)!.waiting_gate).toBe("triage");
    expect(() => driver.retriage(run.id)).toThrow(/not waiting for information/);
  });

  it("waits for a human at triage for an untrusted author, even when the gate is set to always", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: always\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }], { author: "mallory", config });
    const run = driver.startRun(12, { unsafe: true });

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(store.getRun(run.id)!.waiting_gate).toBe("triage");
    expect(store.listDecisions(run.id)).toMatchObject([{ gate: "triage", outcome: "escalate", actor: "system" }]);
    expect(fake.calls()[0]!.stdin).toContain("NOT a trusted author");
    expect(fake.calls()).toHaveLength(1);
  });

  it("trusts an issue the factory created, whoever opened it on GitHub", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { driver, store, project, fake } = setup([{ output: TRIAGE() }], { author: "mallory", config });
    store.markCreatedByFactory(project.id, 12);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human", reason: "waiting at triage gate: gate is set to human" });
    expect(fake.calls()[0]!.stdin).toContain("a trusted author");
    expect(fake.calls()[0]!.stdin).not.toContain("NOT a trusted author");
  });

  it("parks at the triage gate when it is set to human", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { driver, store } = setup([{ output: TRIAGE() }], { config });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("gate is set to human") });
    expect(store.getRun(run.id)!.waiting_gate).toBe("triage");
  });

  it("posts the reasons and ends the run when triage rejects", async () => {
    const { driver, store, comments } = setup([{ output: TRIAGE("REJECT", "\n## Reasons\n- duplicate of #3\n") }]);
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "rejected" });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.issue).toBe(12);
    expect(comments[0]!.body).toMatch(new RegExp(`^<!-- factory:${run.id}:triage-reject -->`));
    expect(comments[0]!.body).toContain("duplicate of #3");
    expect(store.getRun(run.id)!.lease_owner).toBeNull();
  });

  it("asks the questions and parks in needs_info", async () => {
    const { driver, comments } = setup([{ output: TRIAGE("NEEDS_INFO", "\n## Questions\n- Which format?\n") }]);
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", state: "needs_info" });
    expect(comments[0]!.body).toContain("Which format?");
  });

  it("stops without changing state when the usage limit is hit", async () => {
    const { driver, store } = setup([{ stream: "rate_limited" }]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toEqual({ kind: "rate_limited", resetsAt: new Date(1893456000 * 1000).toISOString() });
    expect(store.getRun(run.id)).toMatchObject({ state: "triage", lease_owner: null });
  });

  it("does not start a second run for the same issue, and refuses unqueued issues", () => {
    const { driver, store, project } = setup([]);
    const run = driver.startRun(12);
    expect(driver.startRun(12).id).toBe(run.id);
    store.setQueued(project.id, 12, false);
    store.writeState(run.id, "cancelled");
    expect(() => driver.startRun(12)).toThrow(/not queued/);
  });

  it("will not drive a run another worker holds", async () => {
    const { driver, store } = setup([]);
    const run = driver.startRun(12);
    store.acquireLease(run.id, "someone-else", 60_000);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "stopped", reason: expect.stringContaining("someone-else") });
  });
});
