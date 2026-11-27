import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVerdict } from "@factory/shared";
import { tempDir } from "../../test/helpers.js";
import { findSecurityScan, scanFindings, securityScanPort, securityScanReviewText } from "./scan.js";

// What claude-security 0.13.1 wrote for a planted command injection (a real scan, kept as data).
const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures", "security-scan");
const results = readFileSync(join(FIXTURES, "results.jsonl"), "utf8");

/** A plugin cache with claude-security at these versions, each with scripts/cli.py. */
function pluginCache(versions: string[], marketplace = "claude-plugins-official"): string {
  const home = tempDir("scan-home-");
  for (const v of versions) {
    const scripts = join(home, ".claude", "plugins", "cache", marketplace, "claude-security", v, "scripts");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "cli.py"), "");
  }
  return home;
}

describe("findSecurityScan", () => {
  it("takes the newest installed version, comparing versions as numbers", () => {
    const home = pluginCache(["0.9.0", "0.13.1", "0.2.5", "latest"]);
    expect(findSecurityScan("auto", home)).toBe(join(home, ".claude", "plugins", "cache", "claude-plugins-official", "claude-security", "0.13.1", "scripts", "cli.py"));
  });

  it("finds nothing without the plugin, or when it is off", () => {
    expect(findSecurityScan("auto", tempDir("scan-home-"))).toBeUndefined();
    expect(findSecurityScan("off", pluginCache(["1.0.0"]))).toBeUndefined();
  });

  it("uses a configured path only when it exists, made absolute", () => {
    const file = join(tempDir("scan-path-"), "cli.py");
    expect(findSecurityScan(file)).toBeUndefined();
    writeFileSync(file, "");
    expect(findSecurityScan(relative(process.cwd(), file))).toBe(file);
  });
});

describe("securityScanPort", () => {
  it("skips with the reason when the plugin is missing or off", async () => {
    const request = { worktree: "w", base: "b", effort: "low", model: "opus", outDir: "o", timeoutMs: 1 };
    expect(await securityScanPort("auto", tempDir("scan-home-"))(request)).toEqual({
      skipped: "the claude-security Claude Code plugin is not installed (/plugin install claude-security@claude-plugins-official)",
    });
    expect(await securityScanPort("off", pluginCache(["1.0.0"]))(request)).toEqual({ skipped: "security.scan_tool is off" });
  });
});

describe("scanFindings", () => {
  it("turns the plugin's records into review findings with a stable id", () => {
    expect(scanFindings(results)).toEqual({
      findings: [
        {
          id: "security-scan-44e2f997",
          severity: "critical",
          file: "server.js",
          line: 9,
          claim: "Unauthenticated OS command injection via /ping host parameter",
          evidence: expect.stringContaining("concatenated into a shell command string passed to execSync") as string,
        },
      ],
      problems: [],
    });
    const [finding] = scanFindings(results).findings;
    expect(finding!.evidence).toContain("Exploit: An attacker requests GET /ping?host=127.0.0.1;id");
    expect(finding!.evidence).toContain("Fix: Do not use a shell.");
  });

  it("holds every verified finding but a LOW one at major or above", () => {
    const record = (severity: string, n: number) => JSON.stringify({ id: `F${n}`, title: `t${n}`, severity, claudeSecurityPluginFindingId: `v3:${String(n).repeat(64)}` });
    const { findings } = scanFindings(["CRITICAL", "HIGH", "MEDIUM", "LOW", "high"].map(record).join("\n"));
    expect(findings.map((f) => f.severity)).toEqual(["critical", "major", "major", "minor", "major"]);
  });

  it("falls back to the scan's own id, and leaves out a missing file or a bad line number", () => {
    const { findings } = scanFindings(JSON.stringify({ id: "F2", title: "t", severity: "HIGH", file: "", line: 0 }));
    expect(findings).toEqual([{ id: "security-scan-F2", severity: "major", claim: "t", evidence: "t" }]);
  });

  it("reports lines it cannot read, and still keeps the others", () => {
    expect(scanFindings(`{not json\n${JSON.stringify({ title: "t", severity: "SEVERE" })}\n\n${results}`)).toEqual({
      findings: [expect.objectContaining({ id: "security-scan-44e2f997", severity: "critical" })],
      problems: ["line 1 of the scan's results is not JSON", "line 2 of the scan's results has no known severity or no title"],
    });
  });

  it("reads a severity with stray spaces, as the plugin does", () => {
    expect(scanFindings(JSON.stringify({ id: "F1", title: "t", severity: " high " })).findings.map((f) => f.severity)).toEqual(["major"]);
  });

  // The plugin's id hashes the rule, file and nearby code, so two findings can share it.
  it("gives findings that share an id distinct ids, which the review format requires", () => {
    const same = JSON.stringify({ title: "t", severity: "HIGH", claudeSecurityPluginFindingId: `v3:${"a".repeat(64)}` });
    const { findings } = scanFindings([same, same, same].join("\n"));
    expect(findings.map((f) => f.id)).toEqual(["security-scan-aaaaaaaa", "security-scan-aaaaaaaa-2", "security-scan-aaaaaaaa-3"]);
    expect(() => parseVerdict("review", securityScanReviewText({ findings, notes: [] }))).not.toThrow();
  });
});

describe("securityScanReviewText", () => {
  it("writes a review every lens's reader accepts, CHANGES when a finding blocks", () => {
    const review = parseVerdict("review", securityScanReviewText({ findings: scanFindings(results).findings, notes: ["the scan's verification is partial"] }));
    expect(review.header.VERDICT).toBe("CHANGES");
    expect(review.findings).toHaveLength(1);
    expect(review.summary).toEqual(["Deep scan (claude-security): 1 verified finding, 1 blocking", "Note: the scan's verification is partial"]);
  });

  it("passes with the reason when the scan was skipped or did not finish", () => {
    const skipped = parseVerdict("review", securityScanReviewText({ skipped: "the issue's author is not trusted" }));
    expect(skipped.header.VERDICT).toBe("PASS");
    expect(skipped.summary).toEqual(["Deep scan skipped: the issue's author is not trusted"]);
    const failed = parseVerdict("review", securityScanReviewText({ problem: "the scan took too long and was stopped" }));
    expect(failed.header.VERDICT).toBe("PASS");
    expect(failed.summary).toEqual(["Deep scan did not finish: the scan took too long and was stopped"]);
    expect(parseVerdict("review", securityScanReviewText({ findings: [], notes: [] })).summary).toEqual(["Deep scan (claude-security): no verified findings"]);
  });
});
