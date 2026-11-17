import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { captureConfig, fakeCapture, PLAN, steps } from "../../test/capture-setup.js";
import { setup } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import { MEDIA_MARKER } from "../github/media.js";
import { runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver > capture: skips, cleanup, cancels and limits", () => {
  it("goes on without screenshots when the capture agent skips, or its plan is invalid twice", async () => {
    const skip: FakeStep = { role: "capture", output: "CAPTURE: SKIP\n\n## Summary\n- only a tooltip text changed\n" };
    const external = PLAN.replace('"path":"/feature"', '"path":"https://evil.example/"');
    const invalid: FakeStep = { role: "capture", output: external };
    for (const [capture, pr] of [
      [skip, "No screenshots: `the capture agent found nothing to show (only a tooltip text changed)`"],
      [[invalid, invalid], "Screenshots could not be taken: `capture agent output was rejected twice: plan.pages.1.path: must be a path on the app's own origin"],
    ] as const) {
      const port = fakeCapture();
      const { driver, edits } = setup(steps(capture as FakeStep | FakeStep[]), { config: captureConfig(), capture: port.port });
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
      expect(edits.at(-1)!.body).toContain(`## Screenshots\n${pr}`);
      expect(port.requests).toEqual([]);
    }
  });

  it("undoes what the app left in the worktree, so the branch stays clean", async () => {
    const capture = fakeCapture({ litter: true });
    const { driver, store, root } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    const worktree = store.getRun(run.id)!.worktree_path!;
    expect(existsSync(join(worktree, "server.pid"))).toBe(false);
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(runDirOf(root, run.id), "round-1", "capture-report.md"), "utf8")).toContain("the app left changes in the worktree, which were undone: server.pid");
  });

  it("does not start the app on a worktree with uncommitted changes, and never wipes them", async () => {
    // Someone's edit in the worktree, made before the app would start (here: while the capture agent ran).
    const capture = fakeCapture();
    const { driver, store, root, edits } = setup(steps({ role: "capture", output: PLAN, files: { "human.txt": "mine\n" } }), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);
    await driver.drive(run.id);

    const worktree = store.getRun(run.id)!.worktree_path!;
    expect(capture.requests).toEqual([]);
    expect(readFileSync(join(worktree, "human.txt"), "utf8")).toBe("mine\n");
    const why = "the worktree has uncommitted changes (human.txt), so the app was not started";
    expect(readFileSync(join(runDirOf(root, run.id), "round-1", "capture-report.md"), "utf8")).toContain(why);
    expect(edits.at(-1)!.body).toContain(`## Screenshots\nNo screenshots: \`${why}\``);
  });

  it("stops promptly when the run is cancelled while the app runs, without touching the PR", async () => {
    let published = false;
    const { driver, store, edits } = setup(steps(), {
      config: captureConfig(),
      capture: {
        capture: async (request) => {
          new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(request.runId, "changed my mind");
          // The real engine stops the app and the browser when the signal fires.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("the capture was not told to stop")), 20_000);
            request.signal!.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          return { status: "failed", problem: "cancelled", pages: [], notes: [] };
        },
        publish: async () => {
          published = true;
          return { urls: {} };
        },
        discard: () => undefined,
      },
    });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "cancelled" });
    expect(published).toBe(false);
    expect(edits.some((e) => e.body.includes("## Screenshots"))).toBe(false);
    // Once it stopped, the worker removed the worktree: its work was pushed with the PR.
    expect(existsSync(store.getRun(run.id)!.worktree_path!)).toBe(false);
  });

  it("stops when the run is cancelled while the media uploads, and deletes a release made meanwhile", async () => {
    const capture = fakeCapture();
    const { driver, store, root, edits } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const upload = capture.port.publish;
    let signal: AbortSignal | undefined;
    // `factory cancel` lands while the upload runs; the upload then falls back to a release anyway.
    capture.port.publish = async (runId, prNumber, files, s) => {
      signal = s;
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(runId, "changed my mind");
      return upload(runId, prNumber, files, s);
    };
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "cancelled" });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(edits.some((e) => e.body.includes("## Screenshots"))).toBe(false);
    expect(capture.discarded).toEqual([run.id]);
    expect(existsSync(join(runDirOf(root, run.id), MEDIA_MARKER))).toBe(false);
  });

  it("stops at capture when the usage limit is hit, and captures on the next run", async () => {
    const capture = fakeCapture();
    const { driver, store } = setup(steps([{ role: "capture", stream: "rate_limited" }, { role: "capture", output: PLAN }]), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "rate_limited" });
    expect(store.getRun(run.id)!.state).toBe("capture");
    expect(capture.requests).toEqual([]);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    expect(capture.requests).toHaveLength(1);
  });
});
