import { describe, expect, it } from "vitest";
import { noteMarker, parseNoteMarker } from "./reviews.js";

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
  });
});
