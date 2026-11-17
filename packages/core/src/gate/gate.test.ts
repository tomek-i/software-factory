import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseVerdict } from "@factory/shared";
import { git, GIT_TEST_TIMEOUT, repoWithRemote } from "../../test/helpers.js";
import { createWorktree } from "../git/worktrees.js";
import { GateCancelledError, runQualityGate, type Check } from "./gate.js";
import { scanDiffForSecrets } from "./secrets.js";

// Each test drives real git repos and child processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

// Built by concatenation so this file itself contains no secret-shaped strings.
const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const FAKE_GH_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

const node = (script: string) => `node -e "${script}"`;
// No retries unless a test asks for them, so a failing check runs once.
const check = (name: string, run: string, timeout_sec = 60, retries = 0): Check => ({ name, run, timeout_sec, retries });

function setup() {
  const { root } = repoWithRemote({ "README.md": "# demo\n", ".factory/config.yaml": "version: 1\nchecks: []\n" });
  const wt = createWorktree({ root, runId: "run-1-a", branch: "factory/1-x", defaultBranch: "main" });
  const commit = (path: string, content: string) => {
    writeFileSync(join(wt.path, path), content);
    git(wt.path, "add", "-A");
    git(wt.path, "-c", "user.email=f@example.invalid", "-c", "user.name=f", "commit", "-qm", `add ${path}`);
  };
  const gate = (checks: Check[], round = 1) =>
    runQualityGate({
      runId: "run-1-a",
      worktreePath: wt.path,
      defaultBranch: "main",
      checks,
      roundDir: join(root, ".factory", "runs", "run-1-a", `round-${round}`),
      gitleaks: false,
    });
  return { root, wt, commit, gate };
}

describe("runQualityGate", () => {
  it("passes when every check passes, recording the exact HEAD", async () => {
    const { wt, commit, gate } = setup();
    commit("feature.txt", "hello\n");

    const result = await gate([check("ok", node("console.log('all good')"))]);

    expect(result.passed).toBe(true);
    const verdict = parseVerdict("checks", readFileSync(result.checksFile, "utf8"));
    expect(verdict.header).toEqual({ GATE: "PASS", COMMIT: git(wt.path, "rev-parse", "HEAD") });
    expect(readFileSync(result.logFile, "utf8")).toContain("all good");
  });

  it("fails with the tail of the failing output for the builder", async () => {
    const { commit, gate } = setup();
    commit("feature.txt", "hello\n");

    const result = await gate([
      check("lint", node("console.error('src/a.ts:3 unused variable x'); process.exit(2)")),
      check("test", node("process.exit(0)")),
    ]);

    expect(result.passed).toBe(false);
    const text = readFileSync(result.checksFile, "utf8");
    expect(parseVerdict("checks", text).header.GATE).toBe("FAIL");
    expect(text).toContain("- lint: FAILED (exit 2)");
    expect(text).toContain("- test: passed");
    expect(text).toContain("src/a.ts:3 unused variable x");
  });

  it("fails a check that runs past its timeout, with a clear message", async () => {
    const { commit, gate } = setup();
    commit("feature.txt", "hello\n");
    const started = Date.now();

    const result = await gate([check("slow", node("setTimeout(() => {}, 60000)"), 1)]);

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({ timedOut: true, passed: false });
    expect(readFileSync(result.checksFile, "utf8")).toMatch(/slow: TIMED OUT[\s\S]*timed out after 1s/);
  });

  it("runs a failed check again and passes it when the retry passes, saying it was flaky", async () => {
    const { wt, commit, gate } = setup();
    commit("feature.txt", "hello\n");
    // Fails the first time, passes once the marker file exists.
    const flaky = node("const fs = require('fs'); if (fs.existsSync('ran.txt')) process.exit(0); fs.writeFileSync('ran.txt', ''); process.exit(1)");

    const result = await gate([check("test", flaky, 60, 1)]);

    expect(result.passed).toBe(true);
    expect(result.checks[0]).toMatchObject({ passed: true, attempts: 2 });
    expect(readFileSync(result.checksFile, "utf8")).toContain("- test: passed on attempt 2 (it failed before: flaky)");
    expect(readFileSync(result.logFile, "utf8")).toContain("===== test (attempt 2):");
    expect(readFileSync(join(wt.path, "ran.txt"), "utf8")).toBe("");
  });

  it("fails a check that fails on every attempt, with the number of attempts", async () => {
    const { commit, gate } = setup();
    commit("feature.txt", "hello\n");

    const result = await gate([check("test", node("process.exit(1)"), 60, 2)]);

    expect(result.passed).toBe(false);
    expect(result.checks[0]).toMatchObject({ passed: false, attempts: 3 });
    expect(readFileSync(result.checksFile, "utf8")).toContain("- test: FAILED (exit 1) on all 3 attempts");
  });

  it("lets the checks of two gates take turns instead of running at the same time", async () => {
    const { wt, commit, gate } = setup();
    commit("feature.txt", "hello\n");
    const busy = node("const fs = require('fs'); fs.appendFileSync('turns.log', 'start\\n'); setTimeout(() => fs.appendFileSync('turns.log', 'end\\n'), 500)");

    await Promise.all([gate([check("a", busy)], 1), gate([check("b", busy)], 2)]);

    expect(readFileSync(join(wt.path, "turns.log"), "utf8").split(/\r?\n/).filter(Boolean)).toEqual(["start", "end", "start", "end"]);
  });

  it("fails when the branch adds a secret, without repeating it in the report", async () => {
    const { commit, gate } = setup();
    commit("config.js", `export const key = "${FAKE_AWS_KEY}";\n`);

    const result = await gate([check("ok", node("process.exit(0)"))]);

    expect(result.passed).toBe(false);
    expect(result.secrets).toEqual({ tool: "regex", hits: [{ file: "config.js", line: 1, rule: "aws-access-key-id" }] });
    const text = readFileSync(result.checksFile, "utf8");
    expect(text).toContain("config.js:1 (aws-access-key-id)");
    expect(text).not.toContain(FAKE_AWS_KEY);
  });

  it("runs only the checks it is given, not the worktree's config", async () => {
    const { commit, gate } = setup();
    commit(".factory/config.yaml", "version: 1\nchecks:\n  - name: evil\n    run: exit 0\n");
    const result = await gate([check("real", node("process.exit(1)"))]);
    expect(result.checks.map((c) => c.name)).toEqual(["real"]);
    expect(result.passed).toBe(false);
  });
});

describe("runQualityGate safety", () => {
  it("does not pass the operator's tokens to check commands", async () => {
    const { commit, gate } = setup();
    commit("feature.txt", "x\n");
    process.env.GH_TOKEN = "gho_should_not_leak";
    try {
      const result = await gate([
        check("env", node("process.exit(process.env.GH_TOKEN || process.env.ANTHROPIC_API_KEY ? 1 : process.env.CI ? 0 : 2)")),
      ]);
      expect(result.checks[0]).toMatchObject({ passed: true });
    } finally {
      delete process.env.GH_TOKEN;
    }
  });

  it("finds a secret that a later commit deleted, since a push would still publish it", async () => {
    const { commit, gate, wt } = setup();
    commit("config.js", `export const key = "${FAKE_AWS_KEY}";\n`);
    git(wt.path, "rm", "-q", "config.js");
    git(wt.path, "-c", "user.email=f@example.invalid", "-c", "user.name=f", "commit", "-qm", "remove key");
    const result = await gate([]);
    expect(result.secrets.hits).toEqual([{ file: "config.js", line: 1, rule: "aws-access-key-id" }]);
    expect(result.passed).toBe(false);
  });

  it("stops a running check when cancelled", async () => {
    const { root, wt, commit } = setup();
    commit("feature.txt", "x\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    await expect(
      runQualityGate({
        runId: "run-1-a",
        worktreePath: wt.path,
        defaultBranch: "main",
        checks: [check("slow", node("setTimeout(() => {}, 60000)"))],
        roundDir: join(root, ".factory", "runs", "run-1-a", "round-1"),
        gitleaks: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow(GateCancelledError);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe("scanDiffForSecrets", () => {
  it("reports added lines only, with file and line number", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,0 +10,2 @@",
      "+const fine = 1;",
      `+const token = "${FAKE_GH_TOKEN}";`,
      "@@ -20 +21,0 @@",
      `-const old = "${FAKE_AWS_KEY}";`,
    ].join("\n");
    expect(scanDiffForSecrets(diff)).toEqual([{ file: "a.ts", line: 11, rule: "github-token" }]);
  });

  it("recognises private keys and ignores ordinary code", () => {
    const begin = "-----BEGIN " + "RSA PRIVATE KEY-----";
    expect(scanDiffForSecrets(`+++ b/k.pem\n@@ -0,0 +1 @@\n+${begin}`)).toEqual([{ file: "k.pem", line: 1, rule: "private-key" }]);
    expect(scanDiffForSecrets("+++ b/a.ts\n@@ -0,0 +1 @@\n+const AKIA_LIKE = 'akiaiosfodnn7example';")).toEqual([]);
  });
});
