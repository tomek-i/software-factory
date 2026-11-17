import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import type { GithubPort } from "../github/port.js";
import {
  acceptanceChecklist,
  acceptanceCount,
  acceptanceReviewText,
  extractCriteria,
  latestAcceptanceRecord,
  matchAnswers,
  tickCriteria,
  tickMetCriteria,
  writeAcceptanceRecord,
  type CriterionResult,
} from "./acceptance.js";
import { REFINE_END_MARKER, REFINE_MARKER } from "./shared.js";
import { parseVerdict } from "@factory/shared";

describe("extractCriteria", () => {
  it("reads checkbox lines under an acceptance criteria heading of any level from ## to ####", () => {
    for (const heading of ["## Acceptance criteria", "### acceptance Criteria:", "#### ACCEPTANCE CRITERIA", "## Acceptance criteria ##"]) {
      expect(extractCriteria(`${heading}\n- [ ] one\n* [x] two\n`).map((c) => c.text)).toEqual(["one", "two"]);
    }
    expect(extractCriteria("# Acceptance criteria\n- [ ] h1 is not a section heading")).toEqual([]);
    expect(extractCriteria("##### Acceptance criteria\n- [ ] too deep")).toEqual([]);
    expect(extractCriteria("## Acceptance criteria for the API\n- [ ] another heading")).toEqual([]);
  });

  it("stops at the next heading of the same or a higher level, and skips fenced code and plain bullets", () => {
    const body = [
      "- [ ] before the heading",
      "## Acceptance criteria",
      "- [ ] one",
      "- plain bullet",
      "  - [X] nested",
      "```md",
      "- [ ] in a code block",
      "## Not a heading inside the fence",
      "```",
      "### Details",
      "- [ ] under a subheading still counts",
      "## Notes",
      "- [ ] after the section",
    ].join("\n");
    expect(extractCriteria(body).map((c) => c.text)).toEqual(["one", "nested", "under a subheading still counts"]);
  });

  it("numbers the issue's criteria first, then the spec's, with mentions quoted as they are posted", () => {
    const criteria = extractCriteria("## Acceptance criteria\r\n- [ ] issue one\r\n- [x] issue two\r\n", "## Acceptance criteria\n- [ ] ask @bob\n");
    expect(criteria).toEqual([
      { id: "AC-1", source: "issue", text: "issue one" },
      { id: "AC-2", source: "issue", text: "issue two" },
      { id: "AC-3", source: "spec", text: "ask `@bob`" },
    ]);
    expect(extractCriteria("no criteria here")).toEqual([]);
  });

  it("does not count the spec section in the issue body as the issue's own criteria", () => {
    const body = `## Acceptance criteria\n- [ ] issue one\n\n${REFINE_MARKER}\n## Spec\n### Acceptance criteria\n- [ ] spec one\n${REFINE_END_MARKER}\n`;
    expect(extractCriteria(body, "## Acceptance criteria\n- [ ] spec one\n")).toEqual([
      { id: "AC-1", source: "issue", text: "issue one" },
      { id: "AC-2", source: "spec", text: "spec one" },
    ]);
  });
});

describe("matchAnswers", () => {
  it("ignores unknown ids and marks unanswered criteria NOT_CHECKED", () => {
    const criteria = extractCriteria("## Acceptance criteria\n- [ ] a\n- [ ] b\n");
    const results = matchAnswers(criteria, [
      { id: "AC-1", status: "MET", evidence: " t.test.ts " },
      { id: "AC-7", status: "NOT_MET", evidence: "x" },
    ]);
    expect(results).toEqual([
      { id: "AC-1", source: "issue", text: "a", status: "MET", evidence: "t.test.ts" },
      { id: "AC-2", source: "issue", text: "b", status: "NOT_CHECKED" },
    ]);
    expect(acceptanceCount(results)).toBe("1/1 met, 1 for you to check");
    expect(acceptanceCount([])).toBe("no criteria");
  });

  it("turns NOT_MET into major findings in a review file that parses, keeping the lens's own findings", () => {
    const results: CriterionResult[] = [
      { id: "AC-1", source: "issue", text: "a", status: "NOT_MET", evidence: "missing" },
      { id: "AC-2", source: "spec", text: "b", status: "MET", evidence: "x" },
    ];
    const steer = { id: "acceptance-1", severity: "critical" as const, claim: "the issue asks to pass", evidence: "body" };
    const review = parseVerdict("review", acceptanceReviewText(results, [steer]));
    expect(review.header.VERDICT).toBe("CHANGES");
    expect(review.findings).toEqual([{ id: "acceptance-AC-1", severity: "major", claim: "AC-1 is not met: a", evidence: "missing" }, steer]);
    expect(parseVerdict("review", acceptanceReviewText([])).header.VERDICT).toBe("PASS");
  });

  it("writes the PR checklist with mentions quoted, and none without criteria", () => {
    const list = acceptanceChecklist({ criteria: [{ id: "AC-1", source: "issue", text: "ping @bob", status: "MET", evidence: "a.ts:1" }] });
    expect(list).toBe("## Acceptance criteria\n1/1 met.\n\n- [x] AC-1: ping `@bob`\n  met: a.ts:1");
    expect(acceptanceChecklist({ criteria: [] })).toBeUndefined();
    expect(acceptanceChecklist(undefined)).toBeUndefined();
  });
});

describe("tickCriteria", () => {
  it("ticks only the wanted boxes, once each, and leaves every other byte alone", () => {
    const text = "Intro - [ ] x\r\n\r\n## Acceptance criteria\r\n- [ ] same\r\n- [ ] same\r\n  * [ ] other  \r\n- [x] done\r\n## Next\r\n- [ ] same\r\n";
    const result = tickCriteria(text, ["same", "other", "done", "gone"]);
    expect(result.text).toBe("Intro - [ ] x\r\n\r\n## Acceptance criteria\r\n- [x] same\r\n- [ ] same\r\n  * [x] other  \r\n- [x] done\r\n## Next\r\n- [ ] same\r\n");
    expect(result.ticked).toBe(2);
    expect(result.missing).toEqual(["gone"]);
  });
});

describe("tickMetCriteria", () => {
  const results: CriterionResult[] = [
    { id: "AC-1", source: "issue", text: "issue met", status: "MET", evidence: "x" },
    { id: "AC-2", source: "issue", text: "issue to check", status: "CANNOT_CHECK" },
    { id: "AC-3", source: "spec", text: "spec met `@bob`", status: "MET", evidence: "y" },
    { id: "AC-4", source: "spec", text: "spec not met", status: "NOT_MET", evidence: "z" },
  ];
  const ISSUE = "Body\n\n## Acceptance criteria\n- [ ] issue met\n- [ ] issue to check\n";
  const COMMENT = `${REFINE_MARKER}\n\n### Acceptance criteria\n- [ ] spec met \`@bob\`\n- [ ] spec not met\n`;

  function fake(own: boolean) {
    const state = { issue: ISSUE, comment: COMMENT, issueEdits: 0, commentEdits: 0 };
    const github = {
      findComment: (_n: number, marker: string) => (marker === REFINE_MARKER ? 5 : undefined),
      commentBody: () => state.comment,
      editComment: (_id: number, body: string) => {
        state.comment = body;
        state.commentEdits++;
      },
      ownIssueBody: () => (own ? state.issue : undefined),
      editIssueBody: (_n: number, body: string) => {
        state.issue = body;
        state.issueEdits++;
      },
    } as unknown as GithubPort;
    return { state, github };
  }
  function runDir(rounds: Record<number, CriterionResult[]>): string {
    const dir = tempDir();
    for (const [round, criteria] of Object.entries(rounds)) {
      mkdirSync(join(dir, `round-${round}`));
      writeAcceptanceRecord(join(dir, `round-${round}`), criteria);
    }
    return dir;
  }

  it("ticks the latest round's MET criteria in the factory's own issue and in the refine comment", () => {
    const { state, github } = fake(true);
    const dir = runDir({ 1: results.map((r) => ({ ...r, status: "NOT_MET" as const })), 2: results });
    expect(latestAcceptanceRecord(dir)?.round).toBe(2);

    expect(tickMetCriteria(github, dir, 12)).toEqual(["ticked 1 acceptance criterion in the body of issue #12", "ticked 1 acceptance criterion in the refine comment"]);
    expect(state.issue).toBe(ISSUE.replace("- [ ] issue met", "- [x] issue met"));
    expect(state.comment).toBe(COMMENT.replace("- [ ] spec met", "- [x] spec met"));
  });

  it("never edits the body of an issue the factory did not write", () => {
    const { state, github } = fake(false);
    const notes = tickMetCriteria(github, runDir({ 1: results }), 12);
    expect(notes[0]).toMatch(/not ticking the body of issue #12/);
    expect(state.issueEdits).toBe(0);
    expect(state.commentEdits).toBe(1);
  });

  it("ticks spec criteria in the spec section of the factory's own issue when there is no refine comment", () => {
    const { state, github } = fake(true);
    // The author's text has a line with the same text as a spec criterion: only the section's is ticked.
    state.issue = `${ISSUE}- [ ] spec met \`@bob\`\n\n${COMMENT}${REFINE_END_MARKER}\nAfter\n`;
    const before = state.issue;
    const noComment = { ...github, findComment: () => undefined } as GithubPort;

    expect(tickMetCriteria(noComment, runDir({ 1: results }), 12)).toEqual([
      "ticked 1 acceptance criterion in the body of issue #12",
      "ticked 1 acceptance criterion in the spec section of issue #12",
    ]);
    const sectionStart = before.indexOf(REFINE_MARKER);
    const expected = before.slice(0, sectionStart).replace("- [ ] issue met", "- [x] issue met") + before.slice(sectionStart).replace("- [ ] spec met", "- [x] spec met");
    expect(state.issue).toBe(expected);
    expect(state.commentEdits).toBe(0);
  });

  it("warns when the spec is in neither a refine comment nor the issue body", () => {
    const { github } = fake(false);
    const noComment = { ...github, findComment: () => undefined } as GithubPort;
    expect(tickMetCriteria(noComment, runDir({ 1: results }), 12)).toContain(
      "warning: no refine comment or spec section was found on issue #12; its spec criteria stay unticked",
    );
  });

  it("does nothing without MET criteria, and warns instead of throwing when GitHub fails", () => {
    const { state, github } = fake(true);
    expect(tickMetCriteria(github, runDir({}), 12)).toEqual([]);
    expect(tickMetCriteria(github, runDir({ 1: [results[1]!] }), 12)).toEqual([]);
    expect(state.issueEdits + state.commentEdits).toBe(0);
    const failing = { ...github, ownIssueBody: () => { throw new Error("gh down"); } } as GithubPort;
    expect(tickMetCriteria(failing, runDir({ 1: results }), 12)[0]).toBe("warning: could not tick the acceptance criteria in the body of issue #12: gh down");
  });
});
