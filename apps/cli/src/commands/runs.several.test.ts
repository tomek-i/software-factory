import { describe, expect, it, vi } from "vitest";
import { Store } from "@factory/core";
import { GIT_TEST_TIMEOUT, type FakeStep } from "../../../../packages/core/test/helpers.js";
import { fakeGh, setup, TRIAGE } from "../../test/runs-setup.js";
import { CliError } from "../context.js";
import { runRun, stopActiveRuns } from "./runs.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("factory run with several issues", () => {
  const SLOW_TRIAGE: FakeStep = { output: TRIAGE, sleepMs: 800 };

  /** Each run's triage agent as [started, ended] in ms. */
  function triageSpans(db: Store, projectId: string): Record<number, [number, number]> {
    const spans: Record<number, [number, number]> = {};
    for (const run of db.listRuns({ project_id: projectId })) {
      const agent = db.listAgentRuns(run.id).find((a) => a.role === "triage")!;
      spans[run.issue_number!] = [Date.parse(agent.started_at), Date.parse(agent.ended_at!)];
    }
    db.close();
    return spans;
  }

  it("drives them at the same time and prefixes every line with its issue", async () => {
    const { dir, deps, queue, printed, db, projectId } = setup([SLOW_TRIAGE, SLOW_TRIAGE], "triage: human");
    queue(12, 13);
    const listeners = process.listenerCount("SIGINT");

    const message = await runRun(dir, ["12", "13", "12"], {}, deps);

    // The shared Ctrl+C handler is gone once the last run finishes.
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    const lines = message.split("\n");
    expect(lines[0]).toMatch(/^\[#12\] Run 12-[\w-]+ is waiting at the triage gate/);
    expect(lines.filter((l) => l.startsWith("[#13] Run 13-")).length).toBe(1);
    expect(lines.every((l) => /^\[#1[23]\] /.test(l))).toBe(true);
    expect(printed.every((l) => /^\[#1[23]\] /.test(l))).toBe(true);
    expect(printed).toEqual(expect.arrayContaining(["[#12] -> triage: issue loaded", "[#13] -> triage: issue loaded"]));

    const spans = triageSpans(db(), projectId);
    expect(Object.keys(spans).sort()).toEqual(["12", "13"]);
    expect(spans[12]![0]).toBeLessThan(spans[13]![1]);
    expect(spans[13]![0]).toBeLessThan(spans[12]![1]);
  });

  it("runs no more at once than concurrency.max_runs", async () => {
    const { dir, deps, queue, db, projectId } = setup([SLOW_TRIAGE, SLOW_TRIAGE], "triage: human", "concurrency:\n  max_runs: 1\n");
    queue(12, 13);

    await runRun(dir, ["12", "13"], {}, deps);

    const spans = triageSpans(db(), projectId);
    expect(spans[13]![0]).toBeGreaterThanOrEqual(spans[12]![1]);
  });

  it("skips an issue it cannot run, runs the rest, and still fails the command", async () => {
    const { dir, deps, queue } = setup([{ output: TRIAGE }], "triage: human");
    queue(12);
    const closed = fakeGh({ number: 13, title: "Add another feature", state: "CLOSED", author: "alice" });

    const error = await runRun(dir, ["12", "13"], {}, { ...deps, run: closed }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toMatch(/\[#12\] Run 12-[\w-]+ is waiting at the triage gate/);
    expect(message).toContain("[#13] Skipped: Issue #13 is closed.");
  });

  it("starts no more runs once the usage limit is reached", async () => {
    const { dir, deps, queue, fake } = setup([{ stream: "rate_limited" }], "triage: human", "concurrency:\n  max_runs: 1\n");
    queue(12, 13);

    const message = await runRun(dir, ["12", "13"], {}, deps);

    expect(message).toMatch(/^\[#12\] Usage limit reached/);
    expect(message).toContain("[#13] Not started: the usage limit was reached. Run `factory run 13` after it resets.");
    expect(fake.calls()).toHaveLength(1);
  });

  it("checks every number before queueing or starting anything", async () => {
    const { dir, deps, fake, db, projectId } = setup([]);

    await expect(runRun(dir, ["12", "x"], {}, deps)).rejects.toThrow(/"x" is not an issue number/);

    const store = db();
    expect(store.getIssue(projectId, 12)!.queued_at).toBeFalsy();
    expect(store.listRuns({ project_id: projectId })).toEqual([]);
    store.close();
    expect(fake.calls()).toEqual([]);
  });

  it("Ctrl+C stops every run it is driving and gives back their leases", async () => {
    // The agents would sleep for longer than the test may take, so the test only finishes if Ctrl+C
    // really stopped them. The margins leave room for a busy machine.
    const hang: FakeStep = { output: TRIAGE, sleepMs: 120_000 };
    const { dir, deps, queue, db, projectId } = setup([hang, hang], "triage: human");
    queue(12, 13);

    const running = runRun(dir, ["12", "13"], {}, deps).catch(() => undefined);
    const store = db();
    const agentsRunning = () =>
      store.listRuns({ project_id: projectId }).filter((r) => store.listAgentRuns(r.id).some((a) => a.status === "running" && a.pid)).length;
    for (let i = 0; i < 600 && agentsRunning() < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(agentsRunning()).toBe(2);

    expect(stopActiveRuns()).toBe(2);

    for (const run of store.listRuns({ project_id: projectId })) {
      expect(store.getRun(run.id)!.lease_owner).toBeNull();
      expect(store.listAgentRuns(run.id).map((a) => a.status)).toEqual(["cancelled"]);
    }
    store.close();
    await running;
  }, 60_000);
});
