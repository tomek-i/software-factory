import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildStep, review, reviewConfig, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, reviewsPass, type FakeStep } from "../../test/helpers.js";
import { absoluteRule } from "../agents/prompts.js";
import { runDirOf } from "./driver.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver", () => {
  describe("reviews", () => {
    it("runs reviews.always, and reviews.ui only when triage says the change touches the UI", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: [ux]\n");
      for (const surfaces of ["api", "api, ui"]) {
        const lenses = surfaces.includes("ui") ? ["code", "ux"] : ["code"];
        const triage = TRIAGE().replace("SURFACES: api", `SURFACES: ${surfaces}`);
        const { driver, fake } = setup([{ output: triage }, buildStep("fixed"), ...reviewsPass(lenses)], { config });
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringContaining(`reviews: ${lenses.map((l) => `${l} PASS`).join(", ")};`) });
        expect(fake.calls().slice(2).map((c) => c.role).sort()).toEqual(lenses.map((l) => `reviewer-${l}`));
      }
    });

    it("runs the reviewers at the same time and waits for all of them", async () => {
      const slow = reviewsPass().map((step) => ({ ...step, sleepMs: 1000 }));
      const { driver, store } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...slow]);
      const run = driver.startRun(12);

      await driver.drive(run.id);

      const reviewers = store.listAgentRuns(run.id).filter((a) => a.role.startsWith("reviewer:"));
      expect(reviewers.map((a) => a.role).sort()).toEqual(["reviewer:code", "reviewer:docs", "reviewer:security"]);
      expect(reviewers.every((a) => a.status === "ok")).toBe(true);
      const lastStart = Math.max(...reviewers.map((a) => Date.parse(a.started_at)));
      const firstEnd = Math.min(...reviewers.map((a) => Date.parse(a.ended_at!)));
      expect(lastStart).toBeLessThan(firstEnd);
    });

    it("gives reviewers the change in a file, no shell, and only their own output file to write", async () => {
      const { driver, store, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...reviewsPass()]);
      const run = driver.startRun(12);
      await driver.drive(run.id);

      const dir = runDirOf(root, run.id);
      const change = readFileSync(join(dir, "round-1", "change.diff"), "utf8");
      expect(change).toContain("feat: fixed");
      expect(change).toContain("+fixed");
      const code = fake.calls().find((c) => c.role === "reviewer-code")!;
      expect(code.stdin).toContain(join(dir, "round-1", "change.diff"));
      const settings = JSON.parse(readFileSync(join(dir, "agent", "reviewer-code.settings.json"), "utf8"));
      expect(settings.permissions.deny).toContain("Bash");
      expect(settings.permissions.allow.filter((r: string) => r.startsWith("Edit"))).toEqual([`Edit(${absoluteRule(join(dir, "round-1", "review-code.md"))})`]);
      expect(store.getRun(run.id)!.state).toBe("needs_human");
    });

    it("waits for a human on a blocking finding, but minor ones never hold the run", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const blocking = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("CHANGES", "major") }], { config });
      const run = blocking.driver.startRun(12);
      expect(await blocking.driver.drive(run.id)).toMatchObject({
        reason: "waiting at review gate: reviews: code CHANGES (1 blocking); verifying findings is not automated yet: send it back with `factory resume --to build`, or approve it as is",
      });
      expect(blocking.store.listEvents(run.id).some((e) => e.to_state === "build" && e.from_state === "review")).toBe(false);

      const minor = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("PASS", "minor") }], { config });
      const other = minor.driver.startRun(12);
      expect(await minor.driver.drive(other.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; capture and merge are not automated yet" });
    });

    it("shows hard-rule hits when a review asks for changes", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const touchInfra: FakeStep = { ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "infra/main.tf": "x\n" } };
      const { driver } = setup([{ output: TRIAGE() }, touchInfra, { role: "reviewer-code", output: review("CHANGES", "major") }], { config });
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringMatching(/approve it as is; hard rule: protected path \(infra\/\*\*\): infra\/main\.tf$/) });
    });
  });
});
