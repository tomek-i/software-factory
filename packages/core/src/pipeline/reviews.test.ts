import { describe, expect, it } from "vitest";
import { elapsed, randomStrings } from "../../test/helpers.js";
import { refutedFindings } from "./reviews.js";
import { escapeRegExp, section } from "./shared.js";

/** refutedFindings as it was with regexes, to check the string handling gives the same results. */
function regexRefutedFindings(body: string, known: string[] = []): { id: string; reason: string }[] {
  const text = section(body, "refuted") ?? "";
  const ids = [...known].sort((a, b) => b.length - a.length);
  return text.split(/\r?\n/).flatMap((line) => {
    const item = /^[-*]\s+(.+)$/.exec(line)?.[1];
    if (!item) return [];
    for (const id of ids) {
      const match = new RegExp(`^\`?${escapeRegExp(id)}\`?\\s*:\\s*(.+)$`).exec(item);
      if (match) return [{ id, reason: match[1]!.trim() }];
    }
    const match = /^`?(.+?)`?\s*:\s+(.+)$/.exec(item);
    return match ? [{ id: match[1]!, reason: match[2]!.trim() }] : [];
  });
}

const NBSP = String.fromCharCode(0xa0);
const refuted = (line: string) => `## Refuted\n- first: one\n${line}\n- last: two\n`;

describe("refutedFindings", () => {
  it("splits an unknown id at the first colon followed by whitespace", () => {
    expect(refutedFindings(refuted("- a: b: c"))[1]).toEqual({ id: "a", reason: "b: c" });
    expect(refutedFindings(refuted("- `id`: why"))[1]).toEqual({ id: "id", reason: "why" });
    expect(refutedFindings(refuted("- `id: why"))[1]).toEqual({ id: "id", reason: "why" });
    expect(refutedFindings(refuted("- id`: why"))[1]).toEqual({ id: "id", reason: "why" });
    expect(refutedFindings(refuted("- a.ts:3 x: why"))[1]).toEqual({ id: "a.ts:3 x", reason: "why" });
    expect(refutedFindings(refuted(`- id :${NBSP}why`))[1]).toEqual({ id: "id", reason: "why" });
    expect(refutedFindings(refuted("- id:  "))[1]).toEqual({ id: "id", reason: "" });
    expect(refutedFindings(refuted("- id:x"))).toHaveLength(2);
    expect(refutedFindings(refuted("- id: "))).toHaveLength(2);
    expect(refutedFindings(refuted("-   "))).toHaveLength(2);
    expect(refutedFindings(refuted("  - nested: no"))).toHaveLength(2);
  });

  it("gives the same results as the regexes it replaces", () => {
    const alphabet = ["-", "*", " ", "\t", NBSP, "\r", "`", ":", "a", "b", "."];
    for (const line of randomStrings(alphabet, 5000, 14, 176)) {
      expect(refutedFindings(refuted(line)), JSON.stringify(line)).toEqual(regexRefutedFindings(refuted(line)));
      expect(refutedFindings(refuted(`- ${line}`)), JSON.stringify(line)).toEqual(regexRefutedFindings(refuted(`- ${line}`)));
    }
  });

  it("finishes quickly on long lines that made the regexes backtrack", () => {
    const lines = [`- ${" ".repeat(50_000)}\r`, `- a${" ".repeat(50_000)}:`, `- \`a${" ".repeat(50_000)}:`, `- ${"a:".repeat(25_000)}`];
    for (const line of lines) expect(elapsed(() => refutedFindings(refuted(line)))).toBeLessThan(500);
  });
});
