import { describe, expect, it } from "vitest";
import { editConfigText } from "./edit.js";
import { ConfigError, parseConfig } from "./load.js";

const TEXT = `version: 1
project:
  name: shop
# Where runs stop for you.
gates:
  merge: human # always look before a merge
  pr: always
checks:
  - name: test
    run: pnpm test
loops:
  # Reviews are slow here.
  max_review_rounds: 2
`;

describe("editConfigText", () => {
  it("changes a value in place, keeping comments and the rest of the file", () => {
    const out = editConfigText(TEXT, [{ path: "gates.merge", value: "auto" }]);
    expect(out).toBe(TEXT.replace("merge: human", "merge: auto"));
  });

  it("adds a setting, and a section, the file doesn't have", () => {
    const out = editConfigText(TEXT, [
      { path: "gates.triage", value: "human" },
      { path: "concurrency.max_runs", value: 4 },
    ]);
    expect(parseConfig(out)).toMatchObject({ gates: { triage: "human", merge: "human" }, concurrency: { max_runs: 4 } });
    expect(out).toContain("# Where runs stop for you.");
  });

  it("sets lists, checks and models", () => {
    const out = editConfigText(TEXT, [
      { path: "trust.authors", value: ["alice", "bob"] },
      { path: "checks", value: [{ name: "test", run: "pnpm test" }, { name: "lint", run: "pnpm lint", retries: 0 }] },
      { path: "models.roles", value: { builder: { model: "opus", effort: "high" } } },
    ]);
    const config = parseConfig(out);
    expect(config.trust.authors).toEqual(["alice", "bob"]);
    expect(config.checks.map((c) => [c.name, c.retries])).toEqual([["test", 1], ["lint", 0]]);
    expect(config.models.roles).toEqual({ builder: { model: "opus", effort: "high" } });
  });

  it("takes a reset setting out with its comment, and a section left empty", () => {
    const out = editConfigText(TEXT, [{ path: "loops.max_review_rounds", reset: true }, { path: "gates.pr", value: "auto" }]);
    expect(out).not.toContain("loops");
    expect(out).not.toContain("Reviews are slow");
    expect(parseConfig(out).loops.max_review_rounds).toBe(3);
    expect(parseConfig(out).gates.pr).toBe("auto");
  });

  it("keeps CRLF line endings", () => {
    const out = editConfigText(TEXT.replace(/\n/g, "\r\n"), [{ path: "concurrency.max_runs", value: 3 }]);
    expect(out.split("\n").every((line, i, lines) => i === lines.length - 1 || line.endsWith("\r"))).toBe(true);
  });

  it("refuses a value the config would reject, or a setting changed twice, and returns nothing", () => {
    expect(() => editConfigText(TEXT, [{ path: "loops.max_review_rounds", value: 0 }])).toThrow(ConfigError);
    expect(() => editConfigText(TEXT, [{ path: "gates.merge", value: "sometimes" }])).toThrow(/gates\.merge/);
    expect(() => editConfigText(TEXT, [{ path: "app.url", value: "http://localhost:3000" }])).toThrow(/\{port\}/);
    expect(() => editConfigText(TEXT, [{ path: "gates.pr", value: "auto" }, { path: "gates.pr", reset: true }])).toThrow("gates.pr: changed more than once");
    expect(() => editConfigText(TEXT, [{ path: "gates", reset: true }, { path: "gates.pr", value: "auto" }])).toThrow("gates: changed more than once");
  });
});
