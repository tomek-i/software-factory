import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema, parseVerdict } from "@factory/shared";
import { buildStep, review, reviewConfig, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, REVIEW_PASS, type FakeStep } from "../../test/helpers.js";
import { absoluteRule } from "../agents/prompts.js";
import { approveTarget, runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver", () => {
  describe("reviews", () => {
    describe("verifier", () => {
      const codeOnly = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const confirmed = (id = "code-1") =>
        `VERDICT: CONFIRMED\n\n## Summary\n- real\n\n## Findings\n\`\`\`json\n[{ "id": "${id}", "severity": "major", "file": "feature.txt", "line": 1, "claim": "it says fixed", "evidence": "read line 1" }]\n\`\`\`\n`;
      const refuted = "VERDICT: NONE_CONFIRMED\n\n## Summary\n- not real\n\n## Findings\n```json\n[]\n```\n\n## Refuted\n- code-1: the check accepts exactly that\n";
      /** A builder round after review that changes something, so it has a commit to hand over. */
      const rework = (n: number): FakeStep => ({ ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "rework.txt": `${n}\n` } });

      it("sends confirmed findings back to the builder, who gets them, and reviews the next round", async () => {
        const { driver, store, fake, root } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
            rework(1),
            { role: "reviewer-code", output: REVIEW_PASS },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; gate is set to human" });
        const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
        expect(moves.slice(3)).toEqual(["build>gate", "gate>review", "review>build", "build>gate", "gate>review", "review>needs_human"]);
        expect(store.getRun(run.id)).toMatchObject({ round: 2, review_rounds: 1, build_iterations: 0 });

        const dir = runDirOf(root, run.id);
        expect(parseVerdict("verify", readFileSync(join(dir, "round-1", "verify.md"), "utf8")).header.VERDICT).toBe("CONFIRMED");
        expect(existsSync(join(dir, "round-2", "review-code.md"))).toBe(true);
        const calls = fake.calls();
        const verifier = calls.find((c) => c.role === "verifier")!;
        expect(verifier.stdin).toContain("## Findings to verify");
        expect(verifier.stdin).toContain('"id": "code-1"');
        expect(verifier.stdin).toContain(join(dir, "round-1", "change.diff"));
        const rebuilt = calls.filter((c) => c.role === "builder")[1]!;
        expect(rebuilt.stdin).toContain("The reviewers of round 1 found problems, and a verifier confirmed these");
        expect(rebuilt.stdin).toContain('"claim": "it says fixed"');
        expect(rebuilt.stdin).not.toContain("quality gate failed");
        // The second round's reviewer is asked about its earlier findings first.
        expect(calls.filter((c) => c.role === "reviewer-code")[1]!.stdin).toContain("Your findings from round 1");
      });

      it("treats the review as clear when every blocking finding is refuted, and notes them in the PR", async () => {
        const { driver, store, edits } = setup(
          [{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("CHANGES", "major") }, { role: "verifier", output: refuted }],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          reason:
            "waiting at review gate: reviews: code CHANGES (1 blocking); the verifier refuted all 1 blocking findings; gate is set to human",
        });
        expect(store.listEvents(run.id).some((e) => e.from_state === "review" && e.to_state === "build")).toBe(false);
        expect(edits.at(-1)!.body).toContain(
          "**Refuted by the verifier**\n- code major: it says fixed (feature.txt:1)\n  Refuted: the check accepts exactly that",
        );
        expect(approveTarget(store.getRun(run.id)!)).toBe("capture");
      });

      it("gives the verifier no shell and only verify.md to write", async () => {
        const { driver, root } = setup(
          [{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("CHANGES", "major") }, { role: "verifier", output: refuted }],
          { config: codeOnly },
        );
        const run = driver.startRun(12);
        await driver.drive(run.id);

        const dir = runDirOf(root, run.id);
        const settings = JSON.parse(readFileSync(join(dir, "agent", "verifier.settings.json"), "utf8"));
        expect(settings.permissions.deny).toContain("Bash");
        expect(settings.permissions.allow).toEqual(["Read", "Grep", "Glob", `Edit(${absoluteRule(join(dir, "round-1", "verify.md"))})`]);
      });

      it("rejects a judgement that skips a finding, and escalates when the retry does too", async () => {
        const skips = "VERDICT: NONE_CONFIRMED\n\n## Summary\n- fine\n\n## Findings\n```json\n[]\n```\n";
        const { driver, fake } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: skips },
            { role: "verifier", output: skips },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          kind: "parked",
          reason: "verifier output was rejected twice: not judged (confirm or refute each): code-1",
        });
        expect(fake.calls().at(-1)!.stdin).toContain("- not judged (confirm or refute each): code-1");
      });

      it("after a usage limit, verifies again without rerunning the reviewers", async () => {
        const { driver, fake } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", stream: "rate_limited" },
            { role: "verifier", output: refuted },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({ kind: "rate_limited" });
        expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringContaining("the verifier refuted all 1 blocking findings") });
        expect(fake.calls().filter((c) => c.role === "reviewer-code")).toHaveLength(1);
      });

      it("stops at the review gate when the verifier confirms the same findings two rounds in a row", async () => {
        const { driver, store, edits } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
            rework(1),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          kind: "parked",
          reason:
            "waiting at review gate: reviews: code CHANGES (1 blocking); stalled: the verifier confirmed the same findings in review rounds 1 and 2 (see round-1/verify.md and round-2/verify.md)",
        });
        const parked = store.getRun(run.id)!;
        expect(parked).toMatchObject({ state: "needs_human", parked_from: "review", waiting_gate: "review", review_rounds: 1 });
        // A human may approve it as is, and the PR lists what is still open.
        expect(approveTarget(parked)).toBe("capture");
        expect(store.listEvents(run.id).at(-1)!.data).toMatchObject({ stalled: "reviews", rounds: [1, 2] });
        expect(edits.at(-1)!.body).toContain("**Confirmed by the verifier, not fixed**\n- major: it says fixed (feature.txt:1)");
      });

      it("stops at the review round cap, naming the hard rules, and tells the builder the findings when a human sends it back", async () => {
        const config = `${codeOnly}loops:\n  max_review_rounds: 1\n`;
        const touchInfra: FakeStep = { ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "infra/main.tf": "x\n" } };
        const { driver, store, fake } = setup(
          [
            { output: TRIAGE() },
            touchInfra,
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
            rework(1),
            { role: "reviewer-code", output: REVIEW_PASS },
          ],
          { config },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          kind: "parked",
          reason:
            "waiting at review gate: reviews: code CHANGES (1 blocking); reviews still have confirmed findings after round 1: review round cap reached (1); hard rule: protected path (infra/**): infra/main.tf",
        });

        new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "one more try" });
        await driver.drive(run.id);
        const rebuilt = fake.calls().filter((c) => c.role === "builder")[1]!;
        expect(rebuilt.stdin).toContain("The reviewers of round 1 found problems, and a verifier confirmed these");
        expect(rebuilt.stdin).toContain("A human sent this back to you with this comment: one more try");
        expect(store.getRun(run.id)).toMatchObject({ round: 2, waiting_gate: "review" });
      });
    });
  });
});
