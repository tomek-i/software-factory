import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryConfigSchema, type Finding } from "@factory/shared";
import { describe, expect, it } from "vitest";
import { git, GIT_TEST_TIMEOUT, repoWithRemote, tempDir } from "../../test/helpers.js";
import type { Project } from "../store/store.js";
import { auditDir, findAudit, listAudits, recordFiled, runAudit } from "./audit.js";
import type { ScanRequest, ScanResult, SecurityScanPort } from "./scan.js";

type PortRequest = Omit<ScanRequest, "cli">;
type PortResult = ScanResult | { skipped: string };

const finding: Finding = { id: "security-scan-1a2b3c4d", severity: "critical", claim: "Command injection in ping", evidence: "host goes to execSync", file: "server.js", line: 7 };

function setup() {
  const { root } = repoWithRemote({ "README.md": "# demo\n", "server.js": "merged\n" });
  // Local work the audit must not see: it scans what is merged on GitHub.
  writeFileSync(join(root, "server.js"), "uncommitted\n");
  const project: Project = { id: "p1", name: "demo", repo_path: root, github_repo: "o/demo", created_at: "2026-01-01T00:00:00Z" };
  const config = factoryConfigSchema.parse({ version: 1, checks: [{ name: "ok", run: "true" }] });
  return { root, project, config, dataDir: tempDir("factory-audit-data-") };
}

function fakeScan(result: PortResult | ((request: PortRequest) => Promise<PortResult>)) {
  const requests: PortRequest[] = [];
  const seen: string[] = [];
  const port: SecurityScanPort = (request) => {
    requests.push(request);
    seen.push(readFileSync(join(request.worktree, "server.js"), "utf8"));
    return typeof result === "function" ? result(request) : Promise.resolve(result);
  };
  return { port, requests, seen };
}

describe("runAudit", () => {
  it("scans the merged default branch in a temporary worktree, and keeps the result outside the repo", async () => {
    const { root, project, config, dataDir } = setup();
    const scan = fakeScan({ findings: [finding], notes: ["one record could not be read"] });
    const now = () => new Date("2026-11-27T10:30:00Z");

    const audit = await runAudit({ project, config, scan: scan.port, dataDir, now });

    expect(audit).toMatchObject({ id: "20261127-103000", status: "complete", effort: "medium", findings: [finding], notes: ["one record could not be read"], filed: {} });
    expect(audit.commit).toBe(git(root, "rev-parse", "origin/main"));
    expect(scan.seen).toEqual(["merged\n"]);
    // A whole-repo scan: no base, the audit's own effort, timeout and model.
    expect(scan.requests[0]).toMatchObject({ effort: "medium", model: "opus", timeoutMs: 240 * 60_000, outDir: join(auditDir(project, audit, dataDir), "scan") });
    expect(scan.requests[0]!.base).toBeUndefined();
    expect(existsSync(scan.requests[0]!.worktree)).toBe(false);
    expect(git(root, "worktree", "list")).not.toMatch(/factory-audit-/);
    expect(git(root, "status", "--porcelain")).toBe("M server.js");
    expect(listAudits(project, dataDir)).toEqual([audit]);
  }, GIT_TEST_TIMEOUT);

  it("records a failed, skipped or cancelled scan with the reason, and removes the worktree every time", async () => {
    const { root, project, config, dataDir } = setup();
    let second = 0;
    const now = () => new Date(Date.UTC(2026, 10, 27, 10, 30, second++));

    const failed = await runAudit({ project, config, scan: fakeScan({ problem: "the scan took too long and was stopped" }).port, dataDir, now });
    const skipped = await runAudit({ project, config, scan: fakeScan({ skipped: "the claude-security plugin is not installed" }).port, dataDir, now });
    const controller = new AbortController();
    const cancelled = await runAudit({
      project,
      config,
      scan: fakeScan(() => {
        controller.abort();
        return Promise.resolve({ problem: "the scan was cancelled" });
      }).port,
      signal: controller.signal,
      dataDir,
      now,
    });

    expect(failed).toMatchObject({ status: "failed", problem: "the scan took too long and was stopped", findings: [] });
    expect(skipped).toMatchObject({ status: "skipped", problem: "the claude-security plugin is not installed" });
    expect(cancelled).toMatchObject({ status: "cancelled", problem: "the audit was cancelled" });
    expect(listAudits(project, dataDir).map((a) => a.status)).toEqual(["cancelled", "skipped", "failed"]);

    await expect(runAudit({ project, config, scan: () => Promise.reject(new Error("boom")), dataDir, now })).rejects.toThrow("boom");
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
  }, GIT_TEST_TIMEOUT);

  it("gives a second audit in the same second its own folder, and remembers filed findings", async () => {
    const { project, config, dataDir } = setup();
    const now = () => new Date("2026-11-27T10:30:00Z");
    const first = await runAudit({ project, config, scan: fakeScan({ findings: [finding], notes: [] }).port, dataDir, now });
    const second = await runAudit({ project, config, scan: fakeScan({ findings: [], notes: [] }).port, dataDir, now });

    expect([first.id, second.id]).toEqual(["20261127-103000", "20261127-103000-2"]);
    expect(findAudit(project, undefined, dataDir)!.id).toBe(second.id);
    recordFiled(project, first, finding.id, 42, dataDir);
    expect(findAudit(project, first.id, dataDir)!.filed).toEqual({ [finding.id]: 42 });
  }, GIT_TEST_TIMEOUT);
});
