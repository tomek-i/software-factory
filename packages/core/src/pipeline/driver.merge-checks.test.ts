import { describe, expect, it, vi } from "vitest";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT } from "../../test/helpers.js";
import { approve, CODE_PASS, landOnMain, mergeConfig } from "../../test/merge-setup.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver merge stage: required checks and GitHub's answer", () => {
  it("waits for required checks that are still running, then merges", async () => {
    const { driver, store, pr, merges, seen } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    const ci = (bucket: "pending" | "pass") => [{ name: "test (ubuntu-latest)", bucket }, { name: "pr-title", bucket: "pass" as const }];
    pr.checks = [ci("pending"), ci("pending"), ci("pass")];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toHaveLength(1);
    expect(store.listEvents(run.id).some((e) => e.to_state === "needs_human")).toBe(false);
    const waits = seen.filter((e) => JSON.stringify(e).includes("waiting for required checks on PR #7: test (ubuntu-latest)"));
    expect(waits).toHaveLength(1);
  });

  it("after pushing a re-synced commit, waits for required checks GitHub has not reported yet", async () => {
    const { driver, store, pr, merges, seen, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: human") });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    landOnMain(root, { "other.txt": "meanwhile\n" });
    approve(store, run.id);
    // None at first: CI has not picked up the pushed merge commit yet.
    pr.checks = [[], [{ name: "test (ubuntu-latest)", bucket: "pending" }], [{ name: "test (ubuntu-latest)", bucket: "pass" }]];

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toHaveLength(1);
    expect(seen.some((e) => JSON.stringify(e).includes("waiting for required checks on PR #7: test (ubuntu-latest)"))).toBe(true);
  });

  it("does not judge checks of a commit that is not the one that passed", async () => {
    const { driver, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.checks = [[{ name: "test (ubuntu-latest)", bucket: "fail" }]];
    pr.head = "f".repeat(40);
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringMatching(/^PR #7 moved to fffffff while waiting for checks; only [0-9a-f]{7} passed the gate$/) });
    expect(merges).toEqual([]);
  });

  it("hands a failed required check to a human, naming it, and does not merge", async () => {
    const { driver, store, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.checks = [[{ name: "test (windows-latest)", bucket: "pending" }], [{ name: "test (windows-latest)", bucket: "fail", link: "https://ci/9" }]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required check failed on PR #7: test (windows-latest) (https://ci/9)" });
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "merge" });
    expect(merges).toEqual([]);
  });

  it("stops waiting after merge.checks_timeout_min and asks a human", async () => {
    const { driver, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], {
      config: mergeConfig("merge: always", "merge:\n  checks_timeout_min: 0.002\n"),
    });
    pr.checks = [[{ name: "test (ubuntu-latest)", bucket: "pending" }]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "required checks still running on PR #7 after 0.002 min: test (ubuntu-latest)" });
    expect(merges).toEqual([]);
  });

  it("asks a human when the required checks cannot be read", async () => {
    const { driver, pr, merges } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.checksError = "gh pr checks failed: HTTP 502";
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "could not merge PR #7: gh pr checks failed: HTTP 502" });
    expect(merges).toEqual([]);
  });

  it("hands over to a human when GitHub refuses the merge", async () => {
    const { driver, store, pr } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.mergeError = "required status checks are pending";
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "could not merge PR #7: required status checks are pending" });
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "merge" });
  });
});
