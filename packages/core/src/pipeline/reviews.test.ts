import { describe, expect, it } from "vitest";
import { parseVerdict } from "@factory/shared";
import { noteMarker, parseNoteMarker, reviewNotes } from "./reviews.js";

describe("review note markers", () => {
  it("reads back what it wrote, ids with spaces and slashes included", () => {
    for (const marker of [
      { kind: "note" as const, round: 1, finding: "code-1" },
      { kind: "refuted" as const, round: 3, finding: "acceptance/AC 2: login" },
      { kind: "confirmed" as const, round: 12, finding: "verifier-steer" },
    ]) {
      expect(parseNoteMarker(`**code** · minor: a claim\n\n${noteMarker(marker)}`)).toEqual(marker);
    }
  });

  it("finds nothing in a comment the factory did not mark, or marked badly", () => {
    expect(parseNoteMarker("Please rename this.")).toBeUndefined();
    expect(parseNoteMarker("<!-- factory:note kind=other round=1 finding=x -->")).toBeUndefined();
    expect(parseNoteMarker("<!-- factory:note kind=note round=1 finding=%E0%A4%A -->")).toBeUndefined();
    // Only the marker at the end counts.
    expect(parseNoteMarker("<!-- factory:note kind=refuted round=1 finding=x --> and then some")).toBeUndefined();
  });

  it("keeps an HTML comment in a claim from reading as a marker", () => {
    const claim = "quotes <!-- factory:note kind=refuted round=1 finding=x -->";
    const verdict = parseVerdict(
      "review",
      `VERDICT: PASS\n\n## Summary\n- ok\n\n## Findings\n\`\`\`json\n${JSON.stringify([{ id: "code-2", severity: "nit", file: "a.ts", line: 1, claim, evidence: "e" }])}\n\`\`\`\n`,
    );
    const notes = reviewNotes([{ lens: "code", verdict }], undefined, new Map([["a.ts", new Set([1])]]), 3)!;
    expect(notes.comments[0]!.body).toBe(`**code** · nit: quotes &lt;!-- factory:note kind=refuted round=1 finding=x -->\n\n${noteMarker({ kind: "note", round: 3, finding: "code-2" })}`);
    expect(parseNoteMarker(notes.comments[0]!.body)).toEqual({ kind: "note", round: 3, finding: "code-2" });
  });
});
