import { describe, expect, it } from "vitest";
import { VerdictParseError } from "@factory/shared";
import { issueBody, parseDraft, parseIssueBlocks } from "./draft.js";

const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.\n";
const block = (title: string, header = "UI: NO\nRISK: LOW", sub = false) =>
  `${sub ? "=== SUB-ISSUE ===" : "=== ISSUE ==="}\nTITLE: ${title}\n${header}\n\n${SECTIONS}`;
const draft = (body: string, decision = "PROCEED") => `DECISION: ${decision}\n\n## Summary\n- one issue\n\n${body}`;

function problems(text: string): string[] {
  try {
    parseDraft(text);
  } catch (err) {
    if (err instanceof VerdictParseError) return err.problems;
    throw err;
  }
  return [];
}

describe("parseDraft", () => {
  it("parses a single issue with its flags and sections", () => {
    const parsed = parseDraft(draft(block("Add CSV export", "UI: yes\nRISK: medium")));
    expect(parsed).toMatchObject({ decision: "PROCEED", summary: ["one issue"], reasons: [], subIssues: [] });
    expect(parsed.issue).toEqual({ title: "Add CSV export", ui: true, risk: "MEDIUM", dependsOn: [], body: SECTIONS.trim() });
  });

  it("parses a parent with sub-issues, their order and the reasons to escalate", () => {
    const text = draft(
      [
        "## Reasons\n- the export format is a guess\n",
        block("Exports"),
        block("CSV", "UI: NO\nRISK: LOW", true),
        block("Excel", "UI: NO\nRISK: LOW\nDEPENDS_ON: 1", true),
        block("Docs", "UI: NO\nRISK: LOW\nDEPENDS_ON: #1, 2, 1", true),
      ].join("\n"),
      "ESCALATE",
    );
    const parsed = parseDraft(text);
    expect(parsed.decision).toBe("ESCALATE");
    expect(parsed.reasons).toEqual(["the export format is a guess"]);
    expect(parsed.issue.title).toBe("Exports");
    expect(parsed.subIssues.map((s) => [s.title, s.dependsOn])).toEqual([
      ["CSV", []],
      ["Excel", [1]],
      ["Docs", [1, 2]],
    ]);
  });

  it("accepts Windows line endings, as an edited file may have them", () => {
    expect(parseDraft(draft(block("T")).replace(/\n/g, "\r\n")).issue.title).toBe("T");
  });

  it("rejects a draft without the header or without an issue", () => {
    expect(problems(block("T"))).toContain("file must start with KEY: VALUE header lines");
    expect(problems("DECISION: MAYBE\n\n" + block("T"))[0]).toMatch(/header DECISION/);
    expect(problems(draft("just prose"))).toEqual(['the draft needs exactly one "=== ISSUE ===" line (found 0)']);
  });

  it("rejects a structure that is not one issue, or a parent with two or more sub-issues", () => {
    expect(problems(draft(block("A") + block("B")))).toEqual(['the draft needs exactly one "=== ISSUE ===" line (found 2)']);
    expect(problems(draft(block("A", undefined, true) + block("B", undefined, true) + block("C")))).toEqual([
      '"=== SUB-ISSUE ===" blocks must come after the "=== ISSUE ===" block',
    ]);
    expect(problems(draft(block("A") + block("B", undefined, true)))).toEqual([
      "a parent issue needs at least two sub-issues; write a single issue instead",
    ]);
    const many = Array.from({ length: 11 }, (_, i) => block(`S${i}`, undefined, true)).join("");
    expect(problems(draft(block("A") + many))).toEqual(["at most 10 sub-issues (found 11)"]);
  });

  it("lists every problem of every issue", () => {
    const bad = "=== ISSUE ===\nTITLE:\nUI: maybe\nRISK: LOW\nRISK: HIGH\nLABELS: bug\n\n## Why\nx\n## What\ny\n## What\nz\n## Acceptance criteria\nit works\n";
    expect(problems(draft(bad))).toEqual([
      "issue: header RISK appears more than once",
      "issue: unknown header LABELS (allowed: TITLE, UI, RISK)",
      "issue: TITLE is missing",
      "issue: UI must be YES or NO",
      "issue: section ## What appears more than once",
      "issue: section ## Scope is missing",
      "issue: section ## Out of scope is missing",
      'issue: ## Acceptance criteria needs at least one "- [ ]" checkbox',
    ]);
  });

  it("only lets a sub-issue depend on earlier sub-issues", () => {
    const text = draft(
      block("P") + block("A", "UI: NO\nRISK: LOW\nDEPENDS_ON: 1", true) + block("B", "UI: NO\nRISK: LOW\nDEPENDS_ON: 2, x", true),
    );
    expect(problems(text)).toEqual([
      "sub-issue 1: DEPENDS_ON 1 is not an earlier sub-issue (1 to 0)",
      "sub-issue 2: DEPENDS_ON 2 is not an earlier sub-issue (1 to 1)",
      "sub-issue 2: DEPENDS_ON x is not an earlier sub-issue (1 to 1)",
    ]);
    expect(problems(draft(block("P", "UI: NO\nRISK: LOW\nDEPENDS_ON: 1")))).toEqual([
      "issue: unknown header DEPENDS_ON (allowed: TITLE, UI, RISK)",
    ]);
  });

  it("checks the issues the same way for the retry as for approval", () => {
    expect(parseIssueBlocks(block("T")).problems).toEqual([]);
    expect(parseIssueBlocks("nothing").problems).toHaveLength(1);
  });
});

describe("issueBody", () => {
  it("adds the UI flag, the risk and what the issue depends on below its sections", () => {
    const { issue } = parseDraft(draft(block("T", "UI: YES\nRISK: HIGH")));
    expect(issueBody(issue)).toBe(`${SECTIONS.trim()}\n\n---\n\n**UI change:** yes · **Risk:** high\n`);
    expect(issueBody(issue, [12, 13])).toContain("**Risk:** high · **Depends on:** #12, #13\n");
  });
});
