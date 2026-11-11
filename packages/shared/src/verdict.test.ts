import { describe, expect, it } from "vitest";
import { parseVerdict, VerdictParseError } from "./verdict.js";

const finding = (id: string, severity: string) => ({ id, severity, claim: "c", evidence: "e" });
const block = (items: object[]) => "```json\n" + JSON.stringify(items) + "\n```";

describe("parseVerdict", () => {
  it("parses a triage verdict with summary", () => {
    const text = [
      "DECISION: approve",
      "READINESS: ready",
      "RISK: low",
      "SURFACES: UI, api",
      "",
      "## Summary",
      "- Adds CSV export",
      "* Small change",
      "",
      "## Details",
      "blah",
    ].join("\r\n");

    const v = parseVerdict("triage", text);

    expect(v.header).toEqual({ DECISION: "APPROVE", READINESS: "READY", RISK: "LOW", SURFACES: ["ui", "api"] });
    expect(v.summary).toEqual(["Adds CSV export", "Small change"]);
    expect(v.findings).toEqual([]);
  });

  it("parses findings from a review", () => {
    const text = `VERDICT: CHANGES

## Summary
- One bug

## Findings
\`\`\`json
[{"id":"F1","severity":"major","file":"src/a.ts","line":3,"claim":"off by one","evidence":"loop uses <="}]
\`\`\`
`;
    const v = parseVerdict("review", text);
    expect(v.header.VERDICT).toBe("CHANGES");
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.severity).toBe("major");
  });

  it("accepts 'None' as an empty findings section", () => {
    const v = parseVerdict("review", "VERDICT: PASS\n\n## Findings\nNone.\n");
    expect(v.findings).toEqual([]);
  });

  it("keeps COMMIT case and validates it as a full sha", () => {
    const sha = "a".repeat(40);
    expect(parseVerdict("checks", `GATE: pass\nCOMMIT: ${sha}\n`).header.COMMIT).toBe(sha);
    expect(() => parseVerdict("checks", "GATE: PASS\nCOMMIT: abc123\n")).toThrow(VerdictParseError);
  });

  it("reports every problem at once", () => {
    const text = `VERDICT: MAYBE

## Findings
\`\`\`json
[{"id":"F1","severity":"huge"}]
\`\`\`
`;
    try {
      parseVerdict("review", text);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(VerdictParseError);
      const problems = (err as VerdictParseError).problems;
      expect(problems.some((p) => p.startsWith("header VERDICT"))).toBe(true);
      expect(problems.some((p) => p.startsWith("findings.0.severity"))).toBe(true);
      expect(problems.some((p) => p.startsWith("findings.0.claim"))).toBe(true);
    }
  });

  it("rejects a file without headers", () => {
    expect(() => parseVerdict("build", "I did the work!")).toThrow(/header/);
  });

  it("requires the builder to name the commit it reports on", () => {
    expect(() => parseVerdict("build", "STATUS: READY\n")).toThrow(/COMMIT/);
    expect(parseVerdict("build", `STATUS: ready\nCOMMIT: ${"c".repeat(40)}\n`).header.STATUS).toBe("READY");
  });

  it("rejects duplicate header keys instead of letting the last one win", () => {
    expect(() => parseVerdict("review", "VERDICT: CHANGES\nVERDICT: PASS\n")).toThrow(/more than once/);
  });

  it("finds sections under heading variants", () => {
    const v = parseVerdict("review", `VERDICT: CHANGES\n\n### Findings:\n${block([finding("F1", "major")])}\n`);
    expect(v.findings).toHaveLength(1);
  });

  it("rejects more than one findings block", () => {
    const text = `VERDICT: CHANGES\n\n## Findings\n${block([])}\n${block([finding("F1", "major")])}\n`;
    expect(() => parseVerdict("review", text)).toThrow(/exactly one/);
  });

  it("rejects duplicate finding ids", () => {
    const text = `VERDICT: CHANGES\n\n## Findings\n${block([finding("F1", "major"), finding("F1", "minor")])}\n`;
    expect(() => parseVerdict("review", text)).toThrow(/duplicate finding ids: F1/);
  });

  it("rejects a review verdict that contradicts its findings", () => {
    expect(() => parseVerdict("review", `VERDICT: PASS\n\n## Findings\n${block([finding("F1", "critical")])}\n`)).toThrow(
      /contradicts/,
    );
    expect(() => parseVerdict("review", `VERDICT: CHANGES\n\n## Findings\n${block([finding("F1", "nit")])}\n`)).toThrow(
      /at least one/,
    );
    expect(parseVerdict("review", `VERDICT: PASS\n\n## Findings\n${block([finding("F1", "minor")])}\n`).findings).toHaveLength(1);
  });

  it("rejects a verifier verdict that contradicts its findings", () => {
    expect(() => parseVerdict("verify", "VERDICT: CONFIRMED\n")).toThrow(/confirmed findings listed/);
    expect(() => parseVerdict("verify", `VERDICT: NONE_CONFIRMED\n\n## Findings\n${block([finding("F1", "major")])}\n`)).toThrow(
      /contradicts/,
    );
  });

  it("rejects findings prose without a json block", () => {
    expect(() => parseVerdict("review", "VERDICT: CHANGES\n\n## Findings\n- bad stuff\n")).toThrow(/json array/);
  });
});
