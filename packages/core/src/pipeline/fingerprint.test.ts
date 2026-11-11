import { describe, expect, it } from "vitest";
import type { Finding } from "@factory/shared";
import type { CheckResult, SecretScan } from "../gate/gate.js";
import { findingsFingerprint, gateFingerprint, normaliseOutput } from "./fingerprint.js";

const WORKTREE = "C:\\Users\\dev\\repo\\.worktrees\\run-1";
const SHA = "3f2c9e1d4b5a6789012345678901234567890abc";

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "test",
    command: "pnpm test",
    passed: false,
    timedOut: false,
    exitCode: 1,
    durationMs: 1200,
    tail: "FAIL src/a.test.ts > adds\nexpected 2 to be 3",
    ...overrides,
  };
}

const noSecrets: SecretScan = { tool: "regex", hits: [] };
const gate = (checks: CheckResult[], secrets: SecretScan = noSecrets, path = WORKTREE) => gateFingerprint({ checks, secrets }, path);

describe("normaliseOutput", () => {
  it("strips colours, line endings, whitespace and volatile tokens", () => {
    const text = [
      "\x1b[31mFAIL\x1b[39m  src/a.test.ts (12 ms)\r",
      `at ${WORKTREE}\\src\\a.ts:3:7`,
      `at C:/Users/dev/repo/.worktrees/run-1/src/b.ts`,
      `commit ${SHA.slice(0, 7)} on ${SHA}`,
      "Start at 14:03:22, finished 2026-11-11T14:03:23.512Z",
      "Duration  1.23s (transform 340ms)",
    ].join("\r\n");
    expect(normaliseOutput(text, [WORKTREE])).toBe(
      "FAIL src/a.test.ts (<duration>) at <path>\\src\\a.ts:3:7 at <path>/src/b.ts commit <sha> on <sha> " +
        "Start at <time>, finished <time> Duration <duration> (transform <duration>)",
    );
  });

  it("leaves plain numbers and ordinary words alone", () => {
    expect(normaliseOutput("expected 1234567 to be 7654321 in defaced cafe")).toBe("expected 1234567 to be 7654321 in defaced cafe");
  });

  it("replaces JSON-escaped worktree paths too", () => {
    expect(normaliseOutput(`"file": "C:\\\\Users\\\\dev\\\\repo\\\\.worktrees\\\\run-1\\\\x.ts"`, [WORKTREE])).toBe(`"file": "<path>\\\\x.ts"`);
  });
});

describe("gateFingerprint", () => {
  it("ignores timings, commit shas and the worktree path", () => {
    const first = check({ durationMs: 1200, tail: `checked ${SHA} in 1.2s\nat ${WORKTREE}\\a.ts\nFAIL` });
    const second = check({ durationMs: 9800, tail: `checked ${"9".repeat(39)}a in 340ms\r\nat ${WORKTREE}\\a.ts\nFAIL` });
    expect(gate([first])).toBe(gate([second]));
    // The same failure in a worktree at another path.
    const elsewhere = check({ tail: `checked ${SHA} in 3s\nat D:\\other\\a.ts\nFAIL` });
    expect(gate([elsewhere], noSecrets, "D:\\other")).toBe(gate([first]));
  });

  it("only looks at failed checks", () => {
    const lint = check({ name: "lint", passed: true, exitCode: 0, tail: "all good" });
    expect(gate([lint, check()])).toBe(gate([{ ...lint, tail: "different output, still passing" }, check()]));
  });

  it("differs for different output, failed checks, exit codes, timeouts or secrets", () => {
    const base = gate([check()]);
    expect(gate([check({ tail: "expected 2 to be 4" })])).not.toBe(base);
    expect(gate([check({ name: "lint" })])).not.toBe(base);
    expect(gate([check(), check({ name: "lint" })])).not.toBe(base);
    expect(gate([check({ exitCode: 2 })])).not.toBe(base);
    expect(gate([check({ timedOut: true })])).not.toBe(base);
    expect(gate([check()], { tool: "regex", hits: [{ file: "a.js", line: 1, rule: "aws-access-key-id" }] })).not.toBe(base);
  });

  it("matches secret hits by file and rule, not line or order", () => {
    const hits = (...h: [string, number, string][]) => ({ tool: "gitleaks" as const, hits: h.map(([file, line, rule]) => ({ file, line, rule })) });
    expect(gate([], hits(["a.js", 1, "aws"], ["b.js", 4, "gh"]))).toBe(gate([], hits(["b.js", 9, "gh"], ["a.js", 2, "aws"])));
    expect(gate([], hits(["a.js", 1, "aws"]))).not.toBe(gate([], hits(["a.js", 1, "gh"])));
  });

  it("treats repeated timeouts as the same failure whatever the kill's exit code", () => {
    expect(gate([check({ timedOut: true, exitCode: 1 })])).toBe(gate([check({ timedOut: true, exitCode: undefined })]));
  });
});

describe("findingsFingerprint", () => {
  const finding = (overrides: Partial<Finding> = {}): Finding => ({
    id: "F1",
    severity: "major",
    file: "src/a.ts",
    line: 3,
    claim: "off by one in the loop",
    evidence: "line 3 uses <=",
    ...overrides,
  });

  it("ignores ids, line numbers, evidence and order", () => {
    const a = [finding(), finding({ id: "F2", file: "src/b.ts", claim: "missing null check" })];
    const b = [
      finding({ id: "R2-7", file: "src/b.ts", line: 40, claim: "missing  null check", evidence: "other words" }),
      finding({ id: "R2-1", line: 5 }),
    ];
    expect(findingsFingerprint(a)).toBe(findingsFingerprint(b));
  });

  it("only counts blocking findings", () => {
    expect(findingsFingerprint([finding(), finding({ id: "N", severity: "nit", claim: "naming" })])).toBe(findingsFingerprint([finding()]));
  });

  it("differs for different claims, files or severities", () => {
    const base = findingsFingerprint([finding()]);
    expect(findingsFingerprint([finding({ claim: "wrong loop bound" })])).not.toBe(base);
    expect(findingsFingerprint([finding({ file: "src/c.ts" })])).not.toBe(base);
    expect(findingsFingerprint([finding({ severity: "critical" })])).not.toBe(base);
    expect(findingsFingerprint([finding(), finding({ id: "F2", claim: "another bug" })])).not.toBe(base);
  });
});
