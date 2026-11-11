import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, REVIEW_PASS, reviewsPass, type FakeStep } from "../../test/helpers.js";
import { approveTarget, runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver", () => {
  describe("reviews", () => {
    it("after a usage limit, only runs the lenses that have no review yet", async () => {
      const { driver, fake } = setup([
        { output: TRIAGE() },
        buildStep("fixed"),
        { role: "reviewer-code", output: REVIEW_PASS },
        { role: "reviewer-docs", output: REVIEW_PASS },
        { role: "reviewer-security", stream: "rate_limited" },
        { role: "reviewer-security", output: REVIEW_PASS },
      ]);
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ kind: "rate_limited" });
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("reviews: code PASS, security PASS, docs PASS") });
      expect(fake.calls().slice(2).map((c) => c.role)).toHaveLength(4);
      expect(fake.calls().at(-1)!.role).toBe("reviewer-security");
    });

    it("approving the review gate moves on to capture", async () => {
      const { driver, store } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...reviewsPass()]);
      const run = driver.startRun(12);
      await driver.drive(run.id);

      const parked = store.getRun(run.id)!;
      expect(parked).toMatchObject({ waiting_gate: "review", parked_from: "review" });
      expect(approveTarget(parked)).toBe("capture");
      // A run parked at the review gate before reviews existed gets its reviews when approved.
      expect(approveTarget({ ...parked, parked_from: "gate" })).toBe("review");
    });

    it("reviews a run that was parked at the review gate before reviews existed, once approved", async () => {
      const { driver, store, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...reviewsPass(), ...reviewsPass()]);
      const run = driver.startRun(12);
      await driver.drive(run.id);
      // What the old driver left behind: parked straight from the quality gate, no reviews.
      store.writeState(run.id, "needs_human", { parked_from: "gate", waiting_gate: "review" });
      for (const lens of ["code", "security", "docs"]) rmSync(join(runDirOf(root, run.id), "round-1", `review-${lens}.md`));

      const parked = store.getRun(run.id)!;
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, approveTarget(parked)!, { comment: "approved" });
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("reviews: code PASS, security PASS, docs PASS") });
      expect(fake.calls().filter((c) => c.role!.startsWith("reviewer-"))).toHaveLength(6);
    });

    it("names every reviewer that failed, keeps the others' reviews, and reruns only the failed ones", async () => {
      const failed: FakeStep = { stream: "error_max_turns" };
      const { driver, store, fake } = setup([
        { output: TRIAGE() },
        buildStep("fixed"),
        { role: "reviewer-code", output: REVIEW_PASS },
        { role: "reviewer-docs", ...failed },
        { role: "reviewer-security", ...failed },
        { role: "reviewer-docs", output: REVIEW_PASS },
        { role: "reviewer-security", output: REVIEW_PASS },
      ]);
      const run = driver.startRun(12);

      const outcome = await driver.drive(run.id);
      expect(outcome).toMatchObject({ kind: "parked", reason: expect.stringMatching(/^reviewer \(security\) agent failed .*; reviewer \(docs\) agent failed /) });

      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "review", { comment: "try again" });
      expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringContaining("reviews: code PASS, security PASS, docs PASS") });
      expect(fake.calls().filter((c) => c.role === "reviewer-code")).toHaveLength(1);
    });
  });
});
