import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { securityScanModel, type FactoryConfig, type Finding } from "@factory/shared";
import { factoryDataDir } from "../github/attachments.js";
import { slugify } from "../git/worktrees.js";
import type { Project } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
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

/** Where a project's audits are kept, one folder each. */
export function auditsDir(project: Pick<Project, "name" | "github_repo">, dataDir = factoryDataDir()): string {
  return join(dataDir, "audits", slugify(project.github_repo ?? project.name, 80) || "project");
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

/** Scan the default branch and record the result. Throws only when git cannot give it a checkout. */
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
  const started = now();
  const dir = newAuditDir(auditsDir(project, options.dataDir), started);
  const temp = mkdtempSync(join(tmpdir(), "factory-audit-"));
  const worktree = join(temp, "worktree");
  let added = false;
  let record: AuditRecord;
  try {
    // Detached at the fetched commit: no branch is left behind, and the user's checkout is untouched.
    git(["-c", "core.longpaths=true", "worktree", "add", "--quiet", "--detach", worktree, commit]);
    added = true;
    const result = await options.scan({
      worktree,
      effort: config.security.audit_effort,
      model: securityScanModel(config),
      outDir: join(dir, "scan"),
      timeoutMs: config.security.audit_timeout_min * 60_000,
      signal: options.signal,
    });
    const base = { id: dir.split(/[\\/]/).pop()!, started_at: started.toISOString(), finished_at: now().toISOString(), commit, effort: config.security.audit_effort, filed: {} };
    record = options.signal?.aborted
      ? { ...base, status: "cancelled", findings: [], notes: [], problem: "the audit was cancelled" }
      : "skipped" in result
        ? { ...base, status: "skipped", findings: [], notes: [], problem: result.skipped }
        : "problem" in result
          ? { ...base, status: "failed", findings: [], notes: [], problem: result.problem }
          : { ...base, status: "complete", findings: result.findings, notes: result.notes };
  } finally {
    try {
      if (added) git(["worktree", "remove", "--force", worktree]);
      git(["worktree", "prune"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  writeAudit(dir, record);
  return record;
}

/** A new folder named after the start time; a second audit in the same second gets a suffix. */
function newAuditDir(parent: string, started: Date): string {
  const stamp = started.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  let dir = join(parent, stamp);
  for (let n = 2; existsSync(dir); n++) dir = join(parent, `${stamp}-${n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAudit(dir: string, record: AuditRecord): void {
  writeFileSync(join(dir, "audit.json"), `${JSON.stringify(record, null, 2)}\n`);
}

/** The project's audits, newest first. A folder without a readable record (one still running) is left out. */
export function listAudits(project: Pick<Project, "name" | "github_repo">, dataDir?: string): AuditRecord[] {
  const parent = auditsDir(project, dataDir);
  if (!existsSync(parent)) return [];
  return readdirSync(parent)
    .sort()
    .reverse()
    .flatMap((name) => {
      const record = readAuditFile(join(parent, name));
      return record ? [record] : [];
    });
}

/** One audit by id, or the newest one. */
export function findAudit(project: Pick<Project, "name" | "github_repo">, id: string | undefined, dataDir?: string): AuditRecord | undefined {
  const all = listAudits(project, dataDir);
  return id === undefined ? all[0] : all.find((a) => a.id === id);
}

/** Note that a finding was filed as an issue, so it is not filed twice. */
export function recordFiled(project: Pick<Project, "name" | "github_repo">, audit: AuditRecord, findingId: string, issue: number, dataDir?: string): AuditRecord {
  const updated = { ...audit, filed: { ...audit.filed, [findingId]: issue } };
  writeAudit(join(auditsDir(project, dataDir), audit.id), updated);
  return updated;
}

/** The folder holding an audit's record and the plugin's report. */
export function auditDir(project: Pick<Project, "name" | "github_repo">, audit: Pick<AuditRecord, "id">, dataDir?: string): string {
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
