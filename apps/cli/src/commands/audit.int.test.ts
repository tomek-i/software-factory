import type { AuditPort, SecurityScanPort } from "@factory/core";
import type { Finding } from "@factory/shared";
import { tempDir } from "../../../../packages/core/test/helpers.js";
import { describe, expect, it } from "vitest";
import { setup } from "../../test/runs-setup.js";
import { runAuditFile, runAuditList, runAuditNow, runAuditShow } from "./audit.js";

const finding: Finding = {
  id: "security-scan-1a2b3c4d",
  severity: "critical",
  claim: "Command injection in ping, reported by @someone",
  evidence: "host from the query string goes to execSync in /home/me/repo/server.js",
  file: "server.js",
  line: 7,
};

function audited(visibility: "public" | "private" = "private") {
  const s = setup([], "triage: auto", "security:\n  audit_effort: high\n");
  const dataDir = tempDir("factory-audit-data-");
  const requests: Parameters<SecurityScanPort>[0][] = [];
  const scan: SecurityScanPort = (request) => {
    requests.push(request);
    return Promise.resolve({ findings: [finding], notes: [] });
  };
  const issues: { title: string; body: string }[] = [];
  const github: AuditPort = {
    repoVisibility: () => visibility,
    createIssue: (issue) => {
      issues.push(issue);
      return 31;
    },
  };
  const printed: string[] = [];
  const deps = { scan, github, dataDir, print: (l: string) => printed.push(l) };
  return { ...s, deps, requests, issues, printed };
}

describe("factory audit", () => {
  it("scans with the default branch's settings and lists the findings, with how to file one", async () => {
    const a = audited();
    expect(runAuditList(a.root, a.deps)).toBe("No audits yet. Run `factory audit`.");

    const out = await runAuditNow(a.root, a.deps);

    expect(a.printed[0]).toMatch(/^Scanning the default branch/);
    expect(a.requests[0]!.effort).toBe("high");
    expect(out).toMatch(/^Audit \d{8}-\d{6} of [0-9a-f]{12} \(effort high\): 1 finding, 1 critical or major$/m);
    expect(out).toContain("CRITICAL  Command injection in ping, reported by @someone server.js:7");
    expect(out).toContain("File one as an issue: `factory audit file security-scan-1a2b3c4d`.");
    expect(runAuditList(a.root, a.deps)).toMatch(/^\d{8}-\d{6} {2}[0-9a-f]{7} {2}1 finding, 1 critical or major$/);
    expect(runAuditShow(a.root, undefined, a.deps)).toBe(out);
    expect(() => runAuditShow(a.root, "20200101-000000", a.deps)).toThrow("No audit 20200101-000000. `factory audit list` shows them.");
  });

  it("files a finding as an issue once, with mentions quoted and local paths left out", async () => {
    const a = audited();
    await runAuditNow(a.root, a.deps);

    expect(runAuditFile(a.root, finding.id, {}, a.deps)).toBe("Filed security-scan-1a2b3c4d as issue #31. Queue it with `factory queue 31` to have the factory fix it.");
    expect(a.issues[0]!.title).toBe("Security: Command injection in ping, reported by @someone");
    expect(a.issues[0]!.body).toContain("reported by `@someone`");
    expect(a.issues[0]!.body).not.toContain("/home/me");
    expect(a.issues[0]!.body).toMatch(/### Why[\s\S]*### What[\s\S]*### Acceptance criteria/);
    expect(runAuditShow(a.root, undefined, a.deps)).toContain("(issue #31)");
    expect(() => runAuditFile(a.root, finding.id, {}, a.deps)).toThrow("security-scan-1a2b3c4d is already filed as issue #31.");
    expect(() => runAuditFile(a.root, "security-scan-nope", {}, a.deps)).toThrow(/has no finding security-scan-nope/);
    expect(a.issues).toHaveLength(1);
  });

  it("refuses to file on a public repository unless told to, since the issue would disclose the vulnerability", async () => {
    const a = audited("public");
    await runAuditNow(a.root, a.deps);

    expect(() => runAuditFile(a.root, finding.id, {}, a.deps)).toThrow(/o\/r is public: an issue would disclose this vulnerability to everyone/);
    expect(a.issues).toHaveLength(0);
    expect(runAuditFile(a.root, finding.id, { public: true }, a.deps)).toMatch(/^Filed security-scan-1a2b3c4d as issue #31/);
  });
});
