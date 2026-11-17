import { describe, expect, it } from "vitest";
import { buildStep, READY, setup, TRIAGE } from "../../test/driver-setup.js";
import type { FakeStep } from "../../test/helpers.js";
import { approve, CODE_PASS, landOnMain, mergeConfig } from "../../test/merge-setup.js";
import { waitingCommit } from "./driver.js";

const check = (name: string, bucket: "pending" | "pass" | "fail" | "skipping", link?: string) => ({ name, bucket, ...(link ? { link } : {}) });

describe("PipelineDriver merge stage: required checks before the merge gate", () => {
  it("never asks for approval while a required check has failed on the head commit", async () => {
    const { driver, store, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
    pr.checks = [[check("CodeQL", "fail", "https://ci/1"), check("build", "pass")]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required check failed on PR #7: CodeQL (https://ci/1)" });
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "merge", waiting_gate: null });
    expect(store.listDecisions(run.id).filter((d) => d.gate === "merge")).toEqual([]);
    expect(store.listEvents(run.id).at(-1)!.data).toEqual({ failedChecks: [{ name: "CodeQL", link: "https://ci/1" }] });
    expect(merges).toEqual([]);
  });

  it("does not ask the approver agent either when a required check has failed", async () => {
    const { driver, store, pr, fake } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: auto") });
    pr.checks = [[check("CodeQL", "fail")]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required check failed on PR #7: CodeQL" });
    expect(fake.calls().map((c) => c.role)).not.toContain("approver");
    expect(store.listDecisions(run.id).filter((d) => d.gate === "merge")).toEqual([]);
  });

  it("asks only once pending checks have finished, and names them in the gate's reasons", async () => {
    const { driver, store, pr, merges, seen } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
    pr.checks = [[check("CodeQL", "pending"), check("build", "pass")], [check("CodeQL", "pending"), check("build", "pass")], [check("CodeQL", "pass"), check("build", "pass"), check("docs", "skipping")]];
    const run = driver.startRun(12);

    await driver.drive(run.id);
    const head = waitingCommit(store.listEvents(run.id))!;
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", waiting_gate: "merge" });
    expect(store.listEvents(run.id).at(-1)!.reason).toBe(
      `waiting at merge gate: gate is set to human; required checks passed on ${head.slice(0, 7)}: CodeQL, build, docs (skipped)`,
    );
    // The wait came first, then the question.
    const waited = seen.findIndex((e) => JSON.stringify(e).includes("waiting for required checks on PR #7: CodeQL"));
    const asked = seen.findIndex((e) => e.type === "run:state" && e.to === "needs_human");
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(waited).toBeLessThan(asked);

    approve(store, run.id);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toEqual([{ number: 7, head }]);
  });

  it("reads the checks again right before merging, and stops on a failure that shows up after the gate", async () => {
    const { driver, store, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    // Passed when the gate was decided, failed (a re-run) by the time of the merge.
    pr.checks = [[check("CodeQL", "pass")], [check("CodeQL", "fail")]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required check failed on PR #7: CodeQL" });
    const proceed = store.listDecisions(run.id).find((d) => d.gate === "merge")!;
    expect(proceed).toMatchObject({ outcome: "proceed", comment: expect.stringMatching(/^gate is set to always; required checks passed on [0-9a-f]{7}: CodeQL$/) });
    expect(merges).toEqual([]);
  });

  it("asks a human, not the merge gate, when checks are still running after merge.checks_timeout_min", async () => {
    const { driver, store, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], {
      config: mergeConfig("merge: human", "merge:\n  checks_timeout_min: 0.002\n"),
    });
    pr.checks = [[check("CodeQL", "pending")]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required checks still running on PR #7 after 0.002 min: CodeQL" });
    expect(store.getRun(run.id)).toMatchObject({ waiting_gate: null });
    expect(store.listDecisions(run.id).filter((d) => d.gate === "merge")).toEqual([]);
    expect(merges).toEqual([]);
  });
});

describe("PipelineDriver merge stage: re-sync rounds", () => {
  it("stops when main conflicts in the same files twice in a row", async () => {
    // The builder resolves the conflict by merging main and keeping its own side.
    const resolve: FakeStep = { exec: [["git", "merge", "-X", "ours", "--no-edit", "origin/main"]], output: READY };
    const { driver, store, pr, root, fake } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, resolve, CODE_PASS], {
      config: mergeConfig("merge: always", "loops:\n  max_resyncs: 5\n"),
    });
    const run = driver.startRun(12);
    // Another PR lands on main, touching the same file, every time this run gets to the merge stage.
    let landed = 0;
    pr.onView = () => {
      if (store.getRun(run.id)!.state === "merge") landOnMain(root, { "feature.txt": `main ${++landed}\n` });
    };

    expect(await driver.drive(run.id)).toMatchObject({
      kind: "parked",
      reason: "stalled: bringing in the default branch failed the same way in rounds 1 and 2 (see round-1/resync/conflicts.md and round-2/resync/conflicts.md)",
    });
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "merge", resync_rounds: 1, review_rounds: 0 });
    expect(store.listEvents(run.id).at(-1)!.data).toMatchObject({ stalled: "merge", rounds: [1, 2] });
    expect(fake.calls().filter((c) => c.role === "builder")).toHaveLength(2);
  });
});
