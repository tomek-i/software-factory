import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, READY, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver", () => {
  it("stops the running agent promptly when the run is cancelled from elsewhere", async () => {
    const { driver, store } = setup([{ output: TRIAGE() }, { sleepMs: 30_000 }]);
    const run = driver.startRun(12);
    const started = Date.now();
    const cancelWhenBuilding = setInterval(() => {
      if (store.listAgentRuns(run.id).some((a) => a.role === "builder" && a.status === "running")) {
        clearInterval(cancelWhenBuilding);
        new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(run.id, "changed my mind");
      }
    }, 50);

    const outcome = await driver.drive(run.id);

    clearInterval(cancelWhenBuilding);
    expect(outcome).toEqual({ kind: "finished", state: "cancelled" });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(store.listAgentRuns(run.id).at(-1)).toMatchObject({ role: "builder", status: "cancelled" });
  });

  it("tells the builder only about human decisions made since it last ran", async () => {
    const config = "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }, buildStep("broken"), buildStep("fixed")], { config });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "approved the triage" });

    await driver.drive(run.id);

    expect(fake.calls()[2]!.stdin).toContain("The quality gate failed in round 1");
    expect(fake.calls()[2]!.stdin).not.toContain("approved the triage");
  });

  it("escalates when the builder's hand-over is rejected twice", async () => {
    const uncommitted: FakeStep = { files: { "feature.txt": "fixed\n" }, output: READY };
    const { driver, store, fake, root } = setup([{ output: TRIAGE() }, uncommitted, { output: READY }]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome.kind === "parked" && outcome.reason).toMatch(/builder output was rejected twice: .*uncommitted changes/);
    expect(fake.calls()[2]!.stdin).toContain("the worktree has uncommitted changes");
    expect(store.getRun(run.id)!.state).toBe("needs_human");
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature")).toBe("");
  });

  it("sends a READY hand-over without a TITLE back to the builder, since it names the PR", async () => {
    const untitled = READY.replace(/TITLE: .*\n/, "");
    const { driver, store, fake, root } = setup([{ output: TRIAGE() }, buildStep("x\n", untitled), { output: untitled }]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome.kind === "parked" && outcome.reason).toMatch(/builder output was rejected twice: TITLE is missing/);
    expect(fake.calls()[2]!.stdin).toContain("TITLE is missing");
    expect(store.getRun(run.id)!.state).toBe("needs_human");
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature")).toBe("");
  });

  it("escalates when the builder is blocked", async () => {
    const blocked = "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nNeeds a product decision on pricing.\n";
    const { driver } = setup([{ output: TRIAGE() }, { output: blocked }]);
    const run = driver.startRun(12);
    const outcome = await driver.drive(run.id);
    expect(outcome.kind === "parked" && outcome.reason).toContain("Needs a product decision on pricing.");
  });
});
