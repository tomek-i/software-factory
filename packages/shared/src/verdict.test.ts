import { describe, expect, it } from "vitest";
import { parseVerdict, VerdictParseError } from "./verdict.js";

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

  it("rejects findings prose without a json block", () => {
    expect(() => parseVerdict("review", "VERDICT: CHANGES\n\n## Findings\n- bad stuff\n")).toThrow(/json array/);
  });
});
