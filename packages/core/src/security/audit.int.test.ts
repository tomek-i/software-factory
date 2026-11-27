import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryConfigSchema, type Finding } from "@factory/shared";
import { describe, expect, it } from "vitest";
import { git, GIT_TEST_TIMEOUT, repoWithRemote, tempDir } from "../../test/helpers.js";
import type { Project } from "../store/store.js";
import { auditDir, auditsDir, filedIssue, findAudit, listAudits, recordFiled, runAudit } from "./audit.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
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

    const thrown = await runAudit({ project, config, scan: () => Promise.reject(new Error(`boom in ${root}`)), dataDir, now });
    expect(thrown).toMatchObject({ status: "failed", problem: "the scan failed: boom in ." });
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
  }, GIT_TEST_TIMEOUT);

  it("keeps findings that came back even when Ctrl+C came just after", async () => {
    const { project, config, dataDir } = setup();
    const controller = new AbortController();
    const audit = await runAudit({
      project,
      config,
      scan: fakeScan(() => {
        controller.abort();
        return Promise.resolve({ findings: [finding], notes: [] });
      }).port,
      signal: controller.signal,
      dataDir,
    });
    expect(audit).toMatchObject({ status: "complete", findings: [finding] });
  }, GIT_TEST_TIMEOUT);

  it("throws without leaving an audit folder or temp folder when git can't give it a checkout", async () => {
    const { project, config, dataDir } = setup();
    const temps: string[] = [];
    const run: CommandRunner = (cmd, args, opts) => {
      const added = args.indexOf("add");
      if (args.includes("worktree") && added >= 0) {
        temps.push(args[added + 3]!);
        return { code: 128, stdout: "", stderr: "fatal: no space left" };
      }
      return runCommand(cmd, args, opts);
    };
    await expect(runAudit({ project, config, scan: fakeScan({ findings: [], notes: [] }).port, run, dataDir })).rejects.toThrow("fatal: no space left");
    expect(existsSync(join(temps[0]!, ".."))).toBe(false);
    expect(existsSync(auditsDir(project, dataDir))).toBe(false);
  }, GIT_TEST_TIMEOUT);

  it("records the scan even when its worktree can't be removed, with a note", async () => {
    const { root, project, config, dataDir } = setup();
    const run: CommandRunner = (cmd, args, opts) =>
      args.includes("remove") ? { code: 1, stdout: "", stderr: "Permission denied" } : runCommand(cmd, args, opts);
    const audit = await runAudit({ project, config, scan: fakeScan({ findings: [finding], notes: [] }).port, run, dataDir });

    expect(audit).toMatchObject({ status: "complete", findings: [finding], notes: ["the temporary worktree could not be removed: git worktree failed: Permission denied"] });
    expect(findAudit(project, undefined, dataDir)).toEqual(audit);
    git(root, "worktree", "prune");
  }, GIT_TEST_TIMEOUT);

  it("gives a second audit in the same second its own folder, and remembers filed findings across audits", async () => {
    const { project, config, dataDir } = setup();
    const now = () => new Date("2026-11-27T10:30:00Z");
    const first = await runAudit({ project, config, scan: fakeScan({ findings: [finding], notes: [] }).port, dataDir, now });
    const second = await runAudit({ project, config, scan: fakeScan({ findings: [finding], notes: [] }).port, dataDir, now });

    expect([first.id, second.id]).toEqual(["20261127-103000", "20261127-103000-2"]);
    expect(findAudit(project, undefined, dataDir)!.id).toBe(second.id);
    // Two filings from records read before either was written: neither is lost.
    recordFiled(project, first, finding.id, 42, dataDir);
    recordFiled(project, first, "security-scan-other", 43, dataDir);
    expect(findAudit(project, first.id, dataDir)!.filed).toEqual({ [finding.id]: 42, "security-scan-other": 43 });
    expect(filedIssue(project, finding.id, dataDir)).toBe(42);
  }, GIT_TEST_TIMEOUT);
});

describe("listAudits", () => {
  it("puts the newest first, with a tenth audit in the same second after the ninth", () => {
    const project = { name: "demo", github_repo: "o/demo" };
    const dataDir = tempDir("factory-audit-data-");
    for (const id of ["20261127-103000", "20261127-103000-2", "20261127-103000-10", "20261126-090000"]) {
      mkdirSync(join(auditsDir(project, dataDir), id), { recursive: true });
      writeFileSync(join(auditsDir(project, dataDir), id, "audit.json"), JSON.stringify({ id, findings: [] }));
    }
    expect(listAudits(project, dataDir).map((a) => a.id)).toEqual(["20261127-103000-10", "20261127-103000-2", "20261127-103000", "20261126-090000"]);
  });

  it("keeps two repositories whose names differ only in punctuation apart", () => {
    expect(auditsDir({ name: "x", github_repo: "a-b/c" }, "d")).not.toBe(auditsDir({ name: "x", github_repo: "a/b-c" }, "d"));
    expect(auditsDir({ name: "x", github_repo: "o/my.repo" }, "d")).not.toBe(auditsDir({ name: "x", github_repo: "o/my_repo" }, "d"));
  });
});
