import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, review, reviewConfig, setup, TRIAGE } from "../../test/driver-setup.js";
import { reviewsPass } from "../../test/helpers.js";
import { absoluteRule } from "../agents/prompts.js";
import { runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

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

    it("never holds the run for minor findings, and leaves them as a review on the PR, not in its description", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const { driver, fake, edits, prs, reviews, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("PASS", "minor") }], { config });
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; gate is set to human" });
      expect(fake.calls().some((c) => c.role === "verifier")).toBe(false);
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.every((e) => !e.body.includes("Review notes"))).toBe(true);
      expect(prs[0]!.body).not.toContain("Review notes");
      const commit = /^COMMIT: (\w+)$/m.exec(readFileSync(join(runDirOf(root, run.id), "round-1", "checks.md"), "utf8"))![1]!;
      expect(reviews).toEqual([
        {
          number: 7,
          commit,
          body: `<!-- factory:${run.id}:review-round-1-${commit.slice(0, 12)} -->\nReview notes, left for you to judge. A note about a line of the change is on that line.\n`,
          comments: [{ path: "feature.txt", line: 1, body: "**code** · minor: it says fixed" }],
        },
      ]);
    });

    it("posts a round's review once, even when the round runs again", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const { driver, store, reviews } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("PASS", "minor") }], { config });
      const run = driver.startRun(12);
      await driver.drive(run.id);
      expect(reviews).toHaveLength(1);

      // The review is already written, so the reviewer does not run again; the stage does.
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "review", { comment: "again" });
      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; gate is set to human" });
      expect(reviews).toHaveLength(1);
    });

    it("quotes mentions and removes local paths, and puts every note in the body when GitHub refuses a line", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const findings = [
        { id: "code-1", severity: "minor", file: "feature.txt", line: 1, claim: "ask @bob about /home/alice/notes.txt", evidence: "line 1" },
        { id: "code-2", severity: "nit", claim: "cc @org/team", evidence: "none" },
      ];
      const output = `VERDICT: PASS\n\n## Summary\n- reviewed\n\n## Findings\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\n`;
      const { driver, reviews, reviewErrors, seen } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output }], { config });
      reviewErrors.push("gh api -X failed: Validation Failed (HTTP 422)");
      const run = driver.startRun(12);
      await driver.drive(run.id);

      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.comments).toEqual([]);
      expect(reviews[0]!.body).toContain("**code**\n- minor: ask `@bob` about ~/notes.txt (feature.txt:1)\n- nit: cc `@org/team`\n");
      expect(seen.some((e) => e.type === "info" && e.message.includes("could not post"))).toBe(false);
    });

    it("logs a review it could not post and carries on", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const { driver, reviews, reviewErrors, seen } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("PASS", "minor") }], { config });
      reviewErrors.push("gh api -X failed: HTTP 502");
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; gate is set to human" });
      expect(reviews).toEqual([]);
      expect(seen).toContainEqual(expect.objectContaining({ type: "info", message: "could not post the review notes on PR #7: gh api -X failed: HTTP 502" }));
    });
  });
});
