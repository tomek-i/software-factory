import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { FactoryConfig } from "@factory/shared";
import type { FactoryEvents } from "../events.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { killTree } from "../util/process.js";
import { scanDiffForSecrets, type SecretHit } from "./secrets.js";

export type Check = FactoryConfig["checks"][number];

export interface CheckResult {
  name: string;
  command: string;
  passed: boolean;
  timedOut: boolean;
  exitCode: number | undefined;
  durationMs: number;
  /** Last lines of output, for the builder to act on. */
  tail: string;
}

export interface SecretScan {
  tool: "gitleaks" | "regex";
  hits: SecretHit[];
  /** Set when gitleaks was found but could not run, so the regex fallback was used. */
  note?: string;
}

export interface GateResult {
  passed: boolean;
  head: string;
  checks: CheckResult[];
  secrets: SecretScan;
  checksFile: string;
  logFile: string;
}

export interface GateOptions {
  runId: string;
  worktreePath: string;
  defaultBranch: string;
  /** From the trusted config (default branch), never the worktree's copy. */
  checks: Check[];
  /** `.factory/runs/<run>/round-N`; receives checks.md and checks.log. */
  roundDir: string;
  run?: CommandRunner;
  events?: FactoryEvents;
  /** Whether gitleaks is available; detected from PATH by default. */
  gitleaks?: boolean;
}

const TAIL_LINES = 60;

const tailOf = (text: string) => text.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join("\n");

async function runCheck(check: Check, cwd: string, logFile: string): Promise<CheckResult> {
  const started = Date.now();
  appendFileSync(logFile, `\n===== ${check.name}: ${check.run}\n`);
  const child = execa(check.run, {
    shell: true,
    cwd,
    all: true,
    reject: false,
    windowsHide: true,
    stdin: "ignore",
    // Test runners stay out of watch mode and interactive prompts under CI.
    env: { CI: "1" },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined) killTree(child.pid);
  }, check.timeout_sec * 1000);
  const result = await child;
  clearTimeout(timer);

  const output = typeof result.all === "string" ? result.all : "";
  appendFileSync(logFile, output + `\n===== ${check.name}: ${timedOut ? "TIMED OUT" : `exit ${result.exitCode}`}\n`);
  const tail = timedOut ? `${tailOf(output)}\n\ntimed out after ${check.timeout_sec}s`.trim() : tailOf(output);
  return {
    name: check.name,
    command: check.run,
    passed: !timedOut && result.exitCode === 0,
    timedOut,
    exitCode: result.exitCode,
    durationMs: Date.now() - started,
    tail,
  };
}

function hasGitleaks(run: CommandRunner, cwd: string): boolean {
  return run("gitleaks", ["version"], { cwd }).code === 0;
}

function scanSecrets(options: GateOptions, run: CommandRunner): SecretScan {
  const cwd = options.worktreePath;
  const range = `origin/${options.defaultBranch}..HEAD`;
  let note: string | undefined;
  if (options.gitleaks ?? hasGitleaks(run, cwd)) {
    const report = join(options.roundDir, "gitleaks.json");
    const result = run(
      "gitleaks",
      ["detect", "--source", cwd, "--log-opts", range, "--no-banner", "--redact", "--report-format", "json", "--report-path", report, "--exit-code", "1"],
      { cwd },
    );
    if (result.code === 0) return { tool: "gitleaks", hits: [] };
    if (result.code === 1) {
      const found = JSON.parse(readFileSync(report, "utf8")) as { File: string; StartLine: number; RuleID: string }[];
      return { tool: "gitleaks", hits: found.map((f) => ({ file: f.File, line: f.StartLine, rule: f.RuleID })) };
    }
    note = `gitleaks failed (exit ${result.code}), used the built-in patterns instead`;
  }
  const diff = run("git", ["diff", "--unified=0", "--no-color", `origin/${options.defaultBranch}...HEAD`], { cwd });
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  return { tool: "regex", hits: scanDiffForSecrets(diff.stdout), note };
}

/** checks.md: the verdict file the state machine reads (GATE + COMMIT), plus what the builder needs to fix. */
export function renderChecks(result: Omit<GateResult, "checksFile" | "logFile">): string {
  const lines = [`GATE: ${result.passed ? "PASS" : "FAIL"}`, `COMMIT: ${result.head}`, "", "## Summary"];
  if (result.checks.length === 0) lines.push("- no checks are configured in .factory/config.yaml");
  for (const c of result.checks) {
    const status = c.passed ? "passed" : c.timedOut ? "TIMED OUT" : `FAILED (exit ${c.exitCode})`;
    lines.push(`- ${c.name}: ${status} in ${(c.durationMs / 1000).toFixed(1)}s`);
  }
  const { secrets } = result;
  lines.push(
    secrets.hits.length
      ? `- secret scan (${secrets.tool}): ${secrets.hits.length} possible secret(s) added`
      : `- secret scan (${secrets.tool}): nothing found`,
  );
  if (secrets.note) lines.push(`- note: ${secrets.note}`);

  const failed = result.checks.filter((c) => !c.passed);
  if (failed.length || secrets.hits.length) lines.push("", "## Failures");
  for (const c of failed) {
    lines.push("", `### ${c.name}: \`${c.command}\``, "", "```text", c.tail || "(no output)", "```");
  }
  if (secrets.hits.length) {
    lines.push("", "### secrets", "Remove these from the branch's history and use configuration or environment variables instead:");
    for (const hit of secrets.hits) lines.push(`- ${hit.file}:${hit.line} (${hit.rule})`);
  }
  return lines.join("\n") + "\n";
}

/** Run the configured checks and a secret scan against the worktree's HEAD and write round-N/checks.md. */
export async function runQualityGate(options: GateOptions): Promise<GateResult> {
  const run = options.run ?? runCommand;
  mkdirSync(options.roundDir, { recursive: true });
  const logFile = join(options.roundDir, "checks.log");
  writeFileSync(logFile, "");

  const headResult = run("git", ["rev-parse", "HEAD"], { cwd: options.worktreePath });
  if (headResult.code !== 0) throw new Error(`git rev-parse HEAD failed: ${headResult.stderr}`);
  const head = headResult.stdout;

  const checks: CheckResult[] = [];
  for (const check of options.checks) {
    const result = await runCheck(check, options.worktreePath, logFile);
    checks.push(result);
    options.events?.emit({ type: "gate:check", runId: options.runId, name: check.name, passed: result.passed, durationMs: result.durationMs });
  }
  const secrets = scanSecrets(options, run);

  // The checks must have run on the commit we report: if HEAD moved meanwhile (an agent still
  // running, a manual commit), the result proves nothing about the new commit.
  const after = run("git", ["rev-parse", "HEAD"], { cwd: options.worktreePath }).stdout;
  if (after !== head) throw new Error(`HEAD moved from ${head.slice(0, 7)} to ${after.slice(0, 7)} while the gate ran`);

  const passed = checks.every((c) => c.passed) && secrets.hits.length === 0;
  const checksFile = join(options.roundDir, "checks.md");
  writeFileSync(checksFile, renderChecks({ passed, head, checks, secrets }));
  return { passed, head, checks, secrets, checksFile, logFile };
}
