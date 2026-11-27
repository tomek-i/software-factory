import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isBlocking, type Finding, type Severity } from "@factory/shared";
import { agentEnv } from "../agents/runner.js";
import { newestPluginFile } from "../util/plugins.js";
import { spawnAndWait } from "../util/spawn.js";

/**
 * The `security-scan` review lens: Anthropic's claude-security Claude Code plugin scans the change
 * with its own team of agents and verifies each finding before it reports it. Like narrate, it is
 * called as a plain command (`scripts/cli.py`), never loaded into a factory agent.
 */

/**
 * Where the plugin's CLI is: `off` turns it off, `auto` looks in Claude Code's plugin cache and takes
 * the newest version, anything else is a path to `cli.py`. Undefined when there is none.
 */
export function findSecurityScan(setting: string, home = homedir()): string | undefined {
  if (setting === "off") return undefined;
  if (setting !== "auto") return existsSync(setting) ? resolve(setting) : undefined;
  return newestPluginFile(home, "claude-security", ["scripts", "cli.py"]);
}

/**
 * The scan's severities (CVSS-like, each finding already confirmed by its own verifiers) as review
 * severities. A verified medium is still a reachable hole, and the reviewer contract holds anything
 * that weakens a protection at major or above; only LOW stays out of the way of the merge.
 */
const SEVERITY: Record<string, Severity> = { CRITICAL: "critical", HIGH: "major", MEDIUM: "major", LOW: "minor" };

interface ScanRecord {
  title?: unknown;
  file?: unknown;
  line?: unknown;
  severity?: unknown;
  description?: unknown;
  exploit_scenario?: unknown;
  recommendation?: unknown;
  claudeSecurityPluginFindingId?: unknown;
  id?: unknown;
}

/**
 * The findings of `CLAUDE-SECURITY-RESULTS.jsonl` as review findings. A line that can't be read is
 * reported and the rest still count: one bad record must not hide a verified critical one.
 */
export function scanFindings(jsonl: string): { findings: Finding[]; problems: string[] } {
  const findings: Finding[] = [];
  const problems: string[] = [];
  for (const [i, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record: ScanRecord;
    try {
      record = JSON.parse(line) as ScanRecord;
    } catch {
      problems.push(`line ${i + 1} of the scan's results is not JSON`);
      continue;
    }
    const severity = SEVERITY[text(record.severity).toUpperCase()];
    const title = text(record.title);
    if (!severity || !title) {
      problems.push(`line ${i + 1} of the scan's results has no known severity or no title`);
      continue;
    }
    const evidence = [text(record.description), text(record.exploit_scenario) && `Exploit: ${text(record.exploit_scenario)}`, text(record.recommendation) && `Fix: ${text(record.recommendation)}`]
      .filter(Boolean)
      .join("\n\n");
    findings.push({
      id: uniqueId(findingId(record, findings.length + 1), findings),
      severity,
      ...(text(record.file) ? { file: text(record.file) } : {}),
      ...(Number.isInteger(record.line) && (record.line as number) > 0 ? { line: record.line as number } : {}),
      claim: title,
      evidence: evidence || title,
    });
  }
  return { findings, problems };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The plugin's id hashes the rule, the file and the code around it, so two findings can share one:
 * a review must not, as its parser rejects duplicate ids.
 */
function uniqueId(id: string, taken: Finding[]): string {
  const ids = new Set(taken.map((f) => f.id));
  if (!ids.has(id)) return id;
  let n = 2;
  while (ids.has(`${id}-${n}`)) n++;
  return `${id}-${n}`;
}

/** `security-scan-<8 hex>` from the plugin's id (`v3:<sha256>`), else the scan's own `F1`. */
function findingId(record: ScanRecord, n: number): string {
  const stable = /([0-9a-f]{8})[0-9a-f]*$/i.exec(text(record.claudeSecurityPluginFindingId))?.[1];
  if (stable) return `security-scan-${stable.toLowerCase()}`;
  const own = /^[A-Za-z0-9-]{1,20}$/.exec(text(record.id))?.[0];
  return `security-scan-${own ?? n}`;
}

export interface ScanRequest {
  /** Path to the plugin's `cli.py`. */
  cli: string;
  /** The checkout to scan: a run's worktree, at the commit under review, or the default branch for an audit. */
  worktree: string;
  /** Where the branch left the default branch: the scan covers the changes since. Left out, the whole repository. */
  base?: string;
  effort: string;
  model: string;
  /** `round-N/security-scan/` (or an audit's folder): the plugin's report folder and its output land here. */
  outDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** What runs `cli.py`: Python in isolated mode by default (`python` on Windows, as the plugin asks). */
  interpreter?: string[];
}

export type ScanResult = { findings: Finding[]; notes: string[] } | { problem: string };

/** The scan's findings, or why there are none. Never throws. */
export async function runSecurityScan(request: ScanRequest): Promise<ScanResult> {
  // An earlier attempt at this round (before a usage limit) must not leave its report to be read.
  rmSync(request.outDir, { recursive: true, force: true });
  mkdirSync(request.outDir, { recursive: true });
  const log = openSync(join(request.outDir, "cli-output.log"), "w");
  // An empty gh config folder: gh finds no login there, as for the agents (see agentEnv).
  const ghConfigDir = mkdtempSync(join(tmpdir(), "factory-gh-"));
  let exit: { code: number | null; stdout: string };
  try {
    const [cmd, ...pre] = request.interpreter ?? [process.platform === "win32" ? "python" : "python3", "-IS"];
    exit = await spawnAndWait(
      cmd!,
      [
        ...pre,
        request.cli,
        request.worktree,
        ...(request.base ? ["--base", request.base] : []),
        "--effort",
        request.effort,
        "--model",
        request.model,
        "--output",
        request.outDir,
        // The cost was accepted by turning the lens on.
        "--yes",
        // The plugin's sandbox needs Linux and an API credential rather than the Claude Code login, so
        // the scan runs as the user, like the factory's agents; untrusted runs never get here.
        "--no-sandbox",
      ],
      // agentEnv: no tokens, gh logged out and git's credential helpers off, as for the agents.
      // The plugin starts Claude Code in a session of its own, which a kill of this process group
      // misses: SIGTERM first lets the plugin stop its session itself.
      { cwd: request.outDir, env: agentEnv(process.env, { ghConfigDir }), log, timeoutMs: request.timeoutMs, signal: request.signal, termGraceMs: 10_000 },
    );
  } catch (err) {
    // The code only: the message names local paths, and this reaches the PR.
    return { problem: `the scan did not start (${(err as NodeJS.ErrnoException).code ?? "spawn failed"}); is Python on PATH?` };
  } finally {
    closeSync(log);
    rmSync(ghConfigDir, { recursive: true, force: true });
  }
  if (exit.code === null) return { problem: request.signal?.aborted ? "the scan was cancelled" : "the scan took too long and was stopped" };
  // The plugin also ends with 1 after an unfinished scan that still wrote a report: its findings count.
  const report = latestReport(request.outDir);
  if (!report) return { problem: `the scan wrote no results (exit code ${exit.code}); see ${basename(request.outDir)}/cli-output.log` };
  const { findings, problems } = scanFindings(readFileSync(report.results, "utf8"));
  const notes = [
    ...(exit.code !== 0 ? [`the scan ended with exit code ${exit.code}, so it may be incomplete; see ${basename(request.outDir)}/cli-output.log`] : []),
    ...(report.verification && report.verification !== "verified" ? [`the scan's verification is ${report.verification}`] : []),
    ...problems.slice(0, 3),
  ];
  return { findings, notes };
}

/** How the review stage runs the scan; tests put a fake in its place. */
export type SecurityScanPort = (request: Omit<ScanRequest, "cli">) => Promise<ScanResult | { skipped: string }>;

/** The real scan, with the plugin found as `security.scan_tool` says. */
export function securityScanPort(setting: string, home = homedir()): SecurityScanPort {
  return async (request) => {
    const cli = findSecurityScan(setting, home);
    if (!cli) {
      return { skipped: setting === "off" ? "security.scan_tool is off" : "the claude-security Claude Code plugin is not installed (/plugin install claude-security@claude-plugins-official)" };
    }
    return runSecurityScan({ ...request, cli });
  };
}

/** The newest `CLAUDE-SECURITY-<timestamp>/` the plugin wrote, with its verification status. */
function latestReport(outDir: string): { results: string; verification?: string } | undefined {
  const dirs = readdirSync(outDir)
    .filter((name) => name.startsWith("CLAUDE-SECURITY-"))
    .sort()
    .reverse();
  for (const name of dirs) {
    const dir = join(outDir, name);
    const results = join(dir, "CLAUDE-SECURITY-RESULTS.jsonl");
    if (!existsSync(results)) continue;
    const stamp = readdirSync(dir).find((f) => /^CLAUDE-SECURITY-REVISION-.*\.json$/.test(f));
    let verification: string | undefined;
    try {
      const status = stamp ? (JSON.parse(readFileSync(join(dir, stamp), "utf8")) as { verification?: { status?: unknown } }).verification?.status : undefined;
      verification = typeof status === "string" ? status : undefined;
    } catch {
      // The stamp only adds a note; the findings stand without it.
    }
    return { results, verification };
  }
  return undefined;
}

/**
 * `review-security-scan.md`, the lens's review in the format every lens writes, so the verifier, the
 * review notes and the rest read it like any other. A scan that did not run passes with the reason:
 * it adds to the security lens, it does not replace it.
 */
export function securityScanReviewText(result: ScanResult | { skipped: string }): string {
  const findings = "findings" in result ? result.findings : [];
  const summary =
    "skipped" in result
      ? [`- Deep scan skipped: ${result.skipped}`]
      : "problem" in result
        ? [`- Deep scan did not finish: ${result.problem}`]
        : [`- Deep scan (claude-security): ${countText(findings)}`, ...result.notes.map((n) => `- Note: ${n}`)];
  return [
    `VERDICT: ${findings.some(isBlocking) ? "CHANGES" : "PASS"}`,
    "",
    "## Summary",
    ...summary,
    "",
    "## Findings",
    "```json",
    JSON.stringify(findings, null, 2),
    "```",
    "",
  ].join("\n");
}

function countText(findings: Finding[]): string {
  if (!findings.length) return "no verified findings";
  const blocking = findings.filter(isBlocking).length;
  return `${findings.length} verified finding${findings.length === 1 ? "" : "s"}, ${blocking} blocking`;
}
