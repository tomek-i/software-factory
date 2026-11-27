import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securityScanModel, type FactoryConfig, type Finding } from "@factory/shared";
import { factoryDataDir } from "../github/attachments.js";
import { slugify } from "../git/worktrees.js";
import type { Project } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { redactPaths } from "../util/redact.js";
import type { SecurityScanPort } from "./scan.js";

/**
 * `factory audit`: the claude-security plugin scans the whole default branch, as merged on GitHub,
 * in a temporary worktree. Each audit keeps its record and the plugin's report in the factory's data
 * folder, outside the repository, so nothing about an open vulnerability lands in a commit.
 */

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuditRecord {
  /** The folder's name, from the start time: `20261127-103000`. */
  id: string;
  started_at: string;
  finished_at: string;
  /** The default branch's commit that was scanned. */
  commit: string;
  effort: string;
  status: "complete" | "failed" | "cancelled" | "skipped";
  findings: Finding[];
  notes: string[];
  /** Why there are no findings, when the status is not complete. */
  problem?: string;
  /** Findings filed as issues: finding id to issue number. */
  filed: Record<string, number>;
}

type ProjectRef = Pick<Project, "name" | "github_repo">;

/**
 * Where a project's audits are kept, one folder each. Named after the GitHub repo with only the slash
 * replaced (repo names are already safe file names), so two repos never share a folder.
 */
export function auditsDir(project: ProjectRef, dataDir = factoryDataDir()): string {
  const key = project.github_repo ? project.github_repo.replace("/", "__") : `local-${slugify(project.name, 80) || "project"}`;
  return join(dataDir, "audits", key);
}

export interface AuditOptions {
  project: Project;
  config: Pick<FactoryConfig, "project" | "security" | "models">;
  scan: SecurityScanPort;
  run?: CommandRunner;
  signal?: AbortSignal;
  dataDir?: string;
  now?: () => Date;
}

/**
 * Scan the default branch and record the result. Throws only when git cannot fetch the branch or
 * give it a checkout; a scan that fails, and a cleanup that fails, are recorded instead.
 */
export async function runAudit(options: AuditOptions): Promise<AuditRecord> {
  const { project, config } = options;
  const run = options.run ?? runCommand;
  const now = options.now ?? (() => new Date());
  const root = project.repo_path;
  const branch = config.project.default_branch;
  const git = (args: string[], cwd = root) => {
    const result = run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout || "unknown error"}`);
    return result.stdout.trim();
  };

  git(["fetch", "--quiet", "--", "origin", branch]);
  const commit = git(["rev-parse", `origin/${branch}`]);
  const temp = mkdtempSync(join(tmpdir(), "factory-audit-"));
  const worktree = join(temp, "worktree");
  const cleanup = () => {
    try {
      if (existsSync(worktree)) git(["worktree", "remove", "--force", worktree]);
      git(["worktree", "prune"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  };
  try {
    // Detached at the fetched commit: no branch is left behind, and the user's checkout is untouched.
    git(["-c", "core.longpaths=true", "worktree", "add", "--quiet", "--detach", worktree, commit]);
  } catch (err) {
    cleanup();
    throw err;
  }

  const started = now();
  const dir = newAuditDir(auditsDir(project, options.dataDir), started);
  const base = { id: dir.split(/[\\/]/).pop()!, started_at: started.toISOString(), commit, effort: config.security.audit_effort, filed: {} };
  let record: AuditRecord;
  try {
    const result = await options.scan({
      worktree,
      effort: config.security.audit_effort,
      model: securityScanModel(config),
      outDir: join(dir, "scan"),
      timeoutMs: config.security.audit_timeout_min * 60_000,
      signal: options.signal,
    });
    const finished_at = now().toISOString();
    // Findings that came back count even when Ctrl+C came just after.
    record =
      "findings" in result
        ? { ...base, finished_at, status: "complete", findings: result.findings, notes: result.notes }
        : options.signal?.aborted
          ? { ...base, finished_at, status: "cancelled", findings: [], notes: [], problem: "the audit was cancelled" }
          : "skipped" in result
            ? { ...base, finished_at, status: "skipped", findings: [], notes: [], problem: result.skipped }
            : { ...base, finished_at, status: "failed", findings: [], notes: [], problem: result.problem };
  } catch (err) {
    record = { ...base, finished_at: now().toISOString(), status: "failed", findings: [], notes: [], problem: `the scan failed: ${redactPaths((err as Error).message, { roots: [temp, root] })}` };
  }
  // Recorded before the cleanup, so a worktree that can't be removed doesn't lose the scan.
  writeAudit(dir, record);
  try {
    cleanup();
  } catch (err) {
    record = { ...record, notes: [...record.notes, `the temporary worktree could not be removed: ${(err as Error).message}`] };
    writeAudit(dir, record);
  }
  return record;
}

/** A new folder named after the start time; a second audit in the same second gets a suffix. */
function newAuditDir(parent: string, started: Date): string {
  mkdirSync(parent, { recursive: true });
  const stamp = started.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  for (let n = 1; ; n++) {
    const dir = join(parent, n === 1 ? stamp : `${stamp}-${n}`);
    try {
      // Not recursive: it fails when another audit took the name first, rather than sharing it.
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** Through a temporary file, so a crash mid-write never leaves an unreadable record. */
function writeAudit(dir: string, record: AuditRecord): void {
  const file = join(dir, "audit.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** The project's audits, newest first. A folder without a readable record (one still running) is left out. */
export function listAudits(project: ProjectRef, dataDir?: string): AuditRecord[] {
  const parent = auditsDir(project, dataDir);
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .flatMap((name) => {
      const record = readAuditFile(join(parent, name));
      return record ? [record] : [];
    });
}

/** One audit by id, or the newest one. */
export function findAudit(project: ProjectRef, id: string | undefined, dataDir?: string): AuditRecord | undefined {
  const all = listAudits(project, dataDir);
  return id === undefined ? all[0] : all.find((a) => a.id === id);
}

/** The issue a finding was filed as, by any of the project's audits: a later audit reports the same id. */
export function filedIssue(project: ProjectRef, findingId: string, dataDir?: string): number | undefined {
  for (const audit of listAudits(project, dataDir)) if (audit.filed[findingId] !== undefined) return audit.filed[findingId];
  return undefined;
}

/** Note that a finding was filed as an issue, so it is not filed twice. Re-reads the record so a concurrent filing is kept. */
export function recordFiled(project: ProjectRef, audit: Pick<AuditRecord, "id">, findingId: string, issue: number, dataDir?: string): AuditRecord {
  const dir = join(auditsDir(project, dataDir), audit.id);
  const current = readAuditFile(dir);
  if (!current) throw new Error(`audit ${audit.id} has no readable record`);
  const updated = { ...current, filed: { ...current.filed, [findingId]: issue } };
  writeAudit(dir, updated);
  return updated;
}

/** The folder holding an audit's record and the plugin's report. */
export function auditDir(project: ProjectRef, audit: Pick<AuditRecord, "id">, dataDir?: string): string {
  return join(auditsDir(project, dataDir), audit.id);
}

function readAuditFile(dir: string): AuditRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(join(dir, "audit.json"), "utf8")) as AuditRecord;
    return typeof record.id === "string" && Array.isArray(record.findings) ? { ...record, filed: record.filed ?? {} } : undefined;
  } catch {
    return undefined;
  }
}

const SCHEDULE_MS = { weekly: 7 * 24 * 60 * 60_000, monthly: 30 * 24 * 60 * 60_000 } as const;

/**
 * Whether a scheduled audit is due: none yet, or the newest that wasn't cancelled started longer ago
 * than the schedule's interval. A failed or skipped audit counts, so a missing plugin waits for the
 * next interval rather than retrying every tick; a cancelled one (cut short by `factory stop`) doesn't.
 */
export function auditDue(audits: Pick<AuditRecord, "status" | "started_at">[], schedule: FactoryConfig["security"]["audit_schedule"], now: number): boolean {
  if (schedule === "off") return false;
  const last = audits.filter((a) => a.status !== "cancelled").reduce<number | undefined>((newest, a) => {
    const at = Date.parse(a.started_at);
    return Number.isNaN(at) ? newest : Math.max(newest ?? at, at);
  }, undefined);
  return last === undefined || now - last >= SCHEDULE_MS[schedule];
}
