import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GIT_TEST_TIMEOUT, tempDir } from "../../test/helpers.js";
import { isAlive } from "../util/process.js";
import { runSecurityScan, type ScanRequest } from "./scan.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "test", "fixtures", "security-scan");

/**
 * A stand-in for the plugin's cli.py, run by node: it records what it was given and, as `mode.txt`
 * says, writes a report folder the way the plugin does, fails, or hangs.
 */
function fakeCli(mode: string): string {
  const dir = tempDir("scan-cli-");
  writeFileSync(join(dir, "mode.txt"), mode);
  writeFileSync(join(dir, "results.jsonl"), readFileSync(join(FIXTURES, "results.jsonl")));
  writeFileSync(join(dir, "revision.json"), readFileSync(join(FIXTURES, "revision.json")));
  const script = join(dir, "cli.mjs");
  writeFileSync(
    script,
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const mode = readFileSync(join(here, "mode.txt"), "utf8");
const args = process.argv.slice(2);
writeFileSync(join(here, "seen.json"), JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
const out = args[args.indexOf("--output") + 1];
console.error("progress goes to stderr");
const report = (name, revision) => {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE-SECURITY-RESULTS.jsonl"), mode === "badjson" ? "{nope\\n" : readFileSync(join(here, "results.jsonl")));
  writeFileSync(join(dir, "CLAUDE-SECURITY-REVISION-abc.json"), revision);
};
if (mode === "ok" || mode === "badjson") report("CLAUDE-SECURITY-20261126-235744", readFileSync(join(here, "revision.json")));
if (mode === "partial") {
  report("CLAUDE-SECURITY-20261101-000000", JSON.stringify({ verification: { status: "verified" } }));
  report("CLAUDE-SECURITY-20261126-235744", JSON.stringify({ verification: { status: "partial" } }));
}
if (mode === "refused") process.exit(2);
if (mode === "hang") { writeFileSync(join(here, "pid.txt"), String(process.pid)); setInterval(() => {}, 1000); }
`,
  );
  return script;
}

function request(cli: string, extra: Partial<ScanRequest> = {}): ScanRequest {
  return { cli, worktree: "/w/run-1", base: "abc123", effort: "low", model: "opus", outDir: join(tempDir("scan-out-"), "security-scan"), timeoutMs: 60_000, interpreter: [process.execPath], ...extra };
}

describe("runSecurityScan", () => {
  it("scans the change since the base from its own folder, without the factory's tokens, and reads the findings", async () => {
    const cli = fakeCli("ok");
    const req = request(cli);
    process.env.GH_TOKEN = "secret-for-scan-test";
    try {
      const result = await runSecurityScan(req);
      expect(result).toEqual({ findings: [expect.objectContaining({ id: "security-scan-44e2f997", severity: "critical", file: "server.js", line: 9 })], notes: [] });
    } finally {
      delete process.env.GH_TOKEN;
    }
    const seen = JSON.parse(readFileSync(join(cli, "..", "seen.json"), "utf8")) as { args: string[]; cwd: string; env: Record<string, string> };
    expect(seen.args).toEqual(["/w/run-1", "--base", "abc123", "--effort", "low", "--model", "opus", "--output", req.outDir, "--yes", "--no-sandbox"]);
    // Never the worktree: what the scan leaves behind must not end up in the run's commits.
    expect(seen.cwd.toLowerCase()).toBe(req.outDir.toLowerCase());
    expect(Object.keys(seen.env).some((k) => k.toUpperCase() === "GH_TOKEN")).toBe(false);
    expect(readFileSync(join(req.outDir, "cli-output.log"), "utf8")).toContain("progress goes to stderr");
  });

  it("reads the newest report and notes a verification that is not complete", async () => {
    expect(await runSecurityScan(request(fakeCli("partial")))).toEqual({ findings: [expect.objectContaining({ severity: "critical" })], notes: ["the scan's verification is partial"] });
  });

  it("does not read an earlier attempt's report", async () => {
    const req = request(fakeCli("ok"));
    await runSecurityScan(req);
    writeFileSync(join(req.cli, "..", "mode.txt"), "none");
    expect(await runSecurityScan(req)).toEqual({ problem: "the scan wrote no results; see security-scan/cli-output.log" });
  });

  it("says why there are no findings", async () => {
    expect(await runSecurityScan(request(fakeCli("refused")))).toEqual({ problem: "the scan ended with exit code 2; see security-scan/cli-output.log" });
    expect(await runSecurityScan(request(fakeCli("badjson")))).toEqual({ problem: "the scan's results could not be read: line 1 of the scan's results is not JSON" });
    expect(await runSecurityScan(request(fakeCli("ok"), { interpreter: [join(tempDir("scan-none-"), "no-python")] }))).toEqual({
      problem: "the scan did not start (ENOENT); is Python on PATH?",
    });
  });

  it("stops a scan that takes too long, or is cancelled, and leaves nothing running", async () => {
    for (const how of ["timeout", "cancel"] as const) {
      const cli = fakeCli("hang");
      const controller = new AbortController();
      const pending = runSecurityScan(request(cli, { timeoutMs: how === "timeout" ? 1500 : 60_000, signal: controller.signal }));
      const pidFile = join(cli, "..", "pid.txt");
      while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 50));
      if (how === "cancel") controller.abort();
      expect(await pending).toEqual({ problem: how === "timeout" ? "the scan took too long and was stopped" : "the scan was cancelled" });
      const pid = Number(readFileSync(pidFile, "utf8"));
      for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(isAlive(pid)).toBe(false);
    }
  }, GIT_TEST_TIMEOUT);
});
