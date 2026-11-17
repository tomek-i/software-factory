import { describe, expect, it } from "vitest";
import type { DraftIssue } from "./draft.js";
import { labelProblems, labelsSection, offeredLabels, repoSpelling } from "./labels.js";

const issue = (labels: string[]): DraftIssue => ({ title: "T", ui: false, risk: "LOW", labels, dependsOn: [], body: "" });

describe("offeredLabels", () => {
  it("leaves out the factory's status labels and names the header cannot hold", () => {
    const all = [
      { name: "ui", description: "Visible\n  changes" },
      { name: "factory", description: "Queued" },
      { name: "Factory:in-progress", description: "" },
      { name: "factory-ish", description: "" },
      { name: "a, b", description: "" },
    ];
    expect(offeredLabels(all, "factory")).toEqual([
      { name: "ui", description: "Visible changes" },
      { name: "factory-ish", description: "" },
    ]);
  });

  it("cuts long descriptions", () => {
    expect(offeredLabels([{ name: "x", description: "d".repeat(500) }], "factory")[0]!.description).toHaveLength(200);
  });
});

describe("labelProblems", () => {
  const offered = [{ name: "UI", description: "" }, { name: "bug", description: "" }];

  it("accepts the repository's labels in any case and names each unknown one", () => {
    expect(labelProblems([issue(["ui", "BUG"]), issue([]), issue(["nope"])], offered)).toEqual([
      'sub-issue 2: label "nope" is not one of the repository\'s labels',
    ]);
  });

  it("refuses any label when the repository's labels are unknown, but not a draft without labels", () => {
    expect(labelProblems([issue(["ui"])], undefined)).toEqual([
      "issue: LABELS can't be checked because the repository's labels could not be read; leave LABELS out",
    ]);
    expect(labelProblems([issue([])], undefined)).toEqual([]);
  });

  it("spells labels the repository's way", () => {
    expect(repoSpelling(["ui", "bug"], offered)).toEqual(["UI", "bug"]);
  });
});

describe("labelsSection", () => {
  it("lists the labels as JSON data, or says to leave LABELS out", () => {
    expect(labelsSection([{ name: "ui", description: "Visible" }]).join("\n")).toContain('"name": "ui"');
    expect(labelsSection([]).join("\n")).toContain("no labels to use");
    expect(labelsSection(undefined).join("\n")).toContain("could not be read");
  });
});
