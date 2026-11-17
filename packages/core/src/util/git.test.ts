import { describe, expect, it } from "vitest";
import { elapsed, randomStrings } from "../../test/helpers.js";
import { parseGithubRemote } from "./git.js";

/** parseGithubRemote as it was with a regex, to check the string handling gives the same results. */
function regexParse(url: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

describe("parseGithubRemote", () => {
  it.each([
    ["https://github.com/o/r", "o/r"],
    ["https://github.com/o/r.git", "o/r"],
    ["https://github.com/o/r/", "o/r"],
    ["https://github.com/o/r.git/", "o/r"],
    ["git@github.com:o/r.git", "o/r"],
    ["ssh://git@github.com/o/r.git", "o/r"],
    ["  https://github.com/o/r.git\n", "o/r"],
    ["https://github.com/o/.git", "o/.git"],
    ["https://github.com/o/r.git.git", "o/r.git"],
    ["https://github.com/o/r/x", undefined],
    ["https://github.com//r", undefined],
    ["https://gitlab.com/o/r.git", undefined],
    ["github.com:a:b/r", "a:b/r"],
  ])("%j -> %s", (url, expected) => {
    expect(parseGithubRemote(url)).toBe(expected);
  });

  it("gives the same results as the regex it replaces", () => {
    const alphabet = ["github.com", "github.com:", "github.com/", "/", ":", ".git", "o", "r", " ", "@", "."];
    for (const url of randomStrings(alphabet, 10_000, 8, 176)) {
      expect(parseGithubRemote(url), JSON.stringify(url)).toBe(regexParse(url));
    }
  });

  it("finishes quickly on long remotes that made the regex backtrack", () => {
    const urls = [`${"github.com:".repeat(10_000)}o/${"a".repeat(50_000)} x`, `github.com/${"github.com:".repeat(10_000)}`, `github.com:o/${"a".repeat(50_000)}//`];
    for (const url of urls) expect(elapsed(() => parseGithubRemote(url))).toBeLessThan(500);
  });
});
