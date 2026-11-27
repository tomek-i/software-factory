import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema, parseVerdict, type Finding } from "@factory/shared";
import { buildStep, reviewConfig, setup, TRIAGE } from "../../test/driver-setup.js";
import { REVIEW_PASS, type FakeStep } from "../../test/helpers.js";
import type { ScanRequest, SecurityScanPort } from "../security/scan.js";
import { runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

const HIGH_RISK = TRIAGE().replace("RISK: LOW", "RISK: HIGH");
const INJECTION: Finding = { id: "security-scan-44e2f997", severity: "critical", file: "feature.txt", line: 1, claim: "command injection", evidence: "host reaches execSync" };
const confirmed = `VERDICT: CONFIRMED\n\n## Summary\n- real\n\n## Findings\n\`\`\`json\n${JSON.stringify([INJECTION])}\n\`\`\`\n`;
const refuted = `VERDICT: NONE_CONFIRMED\n\n## Summary\n- not real\n\n## Findings\n\`\`\`json\n[]\n\`\`\`\n\n## Refuted\n- ${INJECTION.id}: the value is a constant\n`;
const config = (when: string) => reviewConfig(`reviews:\n  always: [code]\n  ui: []\nsecurity:\n  scan_when: ${when}\n  scan_effort: medium\n`);

/** A fake scan that records each request and answers in turn; the last answer repeats. */
function fakeScan(...answers: Awaited<ReturnType<SecurityScanPort>>[]): { port: SecurityScanPort; requests: Omit<ScanRequest, "cli">[] } {
  const requests: Omit<ScanRequest, "cli">[] = [];
  return {
    requests,
    port: (request) => {
      requests.push(request);
      return Promise.resolve(answers[Math.min(requests.length - 1, answers.length - 1)]!);
    },
  };
}

const rework: FakeStep = { ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "rework.txt": "1\n" } };
const reviewOf = (root: string, runId: string, round: number) => parseVerdict("review", readFileSync(join(runDirOf(root, runId), `round-${round}`, "review-security-scan.md"), "utf8"));

describe("PipelineDriver", () => {
  describe("security-scan lens", () => {
    it("does not scan while scan_when is off", async () => {
      const scan = fakeScan({ findings: [], notes: [] });
      const { driver, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], { config: config("off"), securityScan: scan.port });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; gate is set to human" });
      expect(scan.requests).toHaveLength(0);
      expect(existsSync(join(runDirOf(root, run.id), "round-1", "review-security-scan.md"))).toBe(false);
    });

    it("scans the gated change, and a confirmed finding sends the run back to the builder", async () => {
      const scan = fakeScan({ findings: [INJECTION], notes: [] }, { findings: [], notes: [] });
      const { driver, store, fake, root } = setup(
        [{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }, { role: "verifier", output: confirmed }, rework, { role: "reviewer-code", output: REVIEW_PASS }],
        { config: config("always"), securityScan: scan.port },
      );
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS, security-scan PASS; gate is set to human" });
      const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
      expect(moves.slice(3)).toEqual(["build>gate", "gate>review", "review>build", "build>gate", "gate>review", "review>needs_human"]);

      const dir = runDirOf(root, run.id);
      const worktree = store.getRun(run.id)!.worktree_path!;
      expect(scan.requests).toHaveLength(2);
      expect(scan.requests[0]).toMatchObject({ worktree, effort: "medium", model: "opus", outDir: join(dir, "round-1", "security-scan"), timeoutMs: 60 * 60_000 });
      expect(scan.requests[0]!.base).toMatch(/^[0-9a-f]{40}$/);
      expect(reviewOf(root, run.id, 1)).toMatchObject({ header: { VERDICT: "CHANGES" }, findings: [INJECTION] });

      const calls = fake.calls();
      expect(calls.find((c) => c.role === "verifier")!.stdin).toContain(`"lens": "security-scan"`);
      expect(calls.filter((c) => c.role === "builder")[1]!.stdin).toContain('"claim": "command injection"');
    });

    it("lets the run go on when the verifier refutes the scan's finding", async () => {
      const scan = fakeScan({ findings: [INJECTION], notes: [] });
      const { driver, store } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }, { role: "verifier", output: refuted }], {
        config: config("always"),
        securityScan: scan.port,
      });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({
        reason: "waiting at review gate: reviews: code PASS, security-scan CHANGES (1 blocking); the verifier refuted all 1 blocking findings; gate is set to human",
      });
      expect(store.listEvents(run.id).some((e) => e.from_state === "review" && e.to_state === "build")).toBe(false);
    });

    it("scans with high_risk only when triage rated the risk HIGH", async () => {
      for (const [triage, scans] of [
        [TRIAGE(), 0],
        [HIGH_RISK, 1],
      ] as const) {
        const scan = fakeScan({ findings: [], notes: [] });
        const { driver, store } = setup([{ output: triage }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], { config: config("high_risk"), securityScan: scan.port });
        const run = driver.startRun(12);
        await driver.drive(run.id);
        // A HIGH risk waits for a human at triage first.
        if (store.getRun(run.id)!.waiting_gate === "triage") {
          new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "go" });
          await driver.drive(run.id);
        }
        expect(store.getRun(run.id)!.waiting_gate).toBe("review");
        expect(scan.requests).toHaveLength(scans);
      }
    });

    it("never scans a change built from an untrusted author's issue, and says so", async () => {
      const scan = fakeScan({ findings: [INJECTION], notes: [] });
      const { driver, store, root, seen } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], {
        author: "mallory",
        config: config("always"),
        securityScan: scan.port,
      });
      const run = driver.startRun(12);
      // An untrusted author's triage always waits for a human first.
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", state: "needs_human" });
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "go" });
      await driver.drive(run.id);

      expect(scan.requests).toHaveLength(0);
      expect(reviewOf(root, run.id, 1)).toMatchObject({ header: { VERDICT: "PASS" }, summary: ["Deep scan skipped: the issue's author is not trusted, and the scan runs without a sandbox"] });
      expect(seen).toContainEqual({ type: "info", runId: run.id, message: "security scan skipped: the issue's author is not trusted, and the scan runs without a sandbox" });
    });

    it("stops the scan promptly when the run is cancelled, and keeps no review of it", async () => {
      let cancel = () => {};
      // Like the real scan: it runs until its signal says stop.
      const port: SecurityScanPort = (request) =>
        new Promise((resolve) => {
          request.signal!.addEventListener("abort", () => resolve({ problem: "the scan was cancelled" }));
          cancel();
        });
      const { driver, store, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], { config: config("always"), securityScan: port });
      const run = driver.startRun(12);
      cancel = () => new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(run.id, "changed my mind");

      expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "cancelled" });
      expect(existsSync(join(runDirOf(root, run.id), "round-1", "review-security-scan.md"))).toBe(false);
    });

    it("gives the scan its own model, never a cheaper one set for the agent lenses", async () => {
      const scan = fakeScan({ findings: [], notes: [] });
      const { driver } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], {
        config: `${config("always")}models:\n  default: haiku\n  roles:\n    reviewer: haiku\n`,
        securityScan: scan.port,
      });
      await driver.drive(driver.startRun(12).id);
      expect(scan.requests[0]!.model).toBe("opus");
    });

    it("undoes what the scan left in the worktree and notes it, so the run can still be pushed", async () => {
      const port: SecurityScanPort = (request) => {
        writeFileSync(join(request.worktree, "scan-notes.txt"), "left behind\n");
        writeFileSync(join(request.worktree, "feature.txt"), "changed by the scan\n");
        return Promise.resolve({ findings: [], notes: [] });
      };
      const { driver, store, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], { config: config("always"), securityScan: port });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS, security-scan PASS; gate is set to human" });
      const worktree = store.getRun(run.id)!.worktree_path!;
      expect(existsSync(join(worktree, "scan-notes.txt"))).toBe(false);
      expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toBe("fixed\n");
      expect(reviewOf(root, run.id, 1).summary).toEqual(["Deep scan (claude-security): no verified findings", "Note: the scan left changes in the worktree, undone: feature.txt, scan-notes.txt"]);
    });

    it("goes on without the scan when it fails, with the reason in its review", async () => {
      const { driver, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], {
        config: config("always"),
        securityScan: () => Promise.reject(new Error("disk full")),
      });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS, security-scan PASS; gate is set to human" });
      expect(reviewOf(root, run.id, 1).summary).toEqual(["Deep scan did not finish: the scan failed: disk full"]);
    });
  });
});
