import { isBlocking, type Finding } from "@factory/shared";
import { ghPort, type AuditPort } from "../github/port.js";
import { quietMentions } from "../pipeline/shared.js";
import { filedIssue, findAudit, listAudits, recordFiled, runAudit, type AuditRecord } from "../security/audit.js";
import { securityScanPort, type SecurityScanPort } from "../security/scan.js";
import type { Project } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { redactPaths } from "../util/redact.js";
import { ServiceError } from "./errors.js";
import { trustedConfig, type ServiceContext } from "./runs.js";

export interface AuditDeps {
  run?: CommandRunner;
  /** The scan; the claude-security plugin's CLI by default. */
  scan?: SecurityScanPort;
  github?: AuditPort;
  signal?: AbortSignal;
  /** The factory's data folder; `factoryDataDir()` by default. */
  dataDir?: string;
}

/**
 * Scan the project's default branch with the claude-security plugin. The settings come from the
 * default branch, like a run's: the working copy can't change what an audit does.
 */
export function auditProject(ctx: ServiceContext, deps: AuditDeps = {}): Promise<AuditRecord> {
  const config = trustedConfig(ctx.project, ctx.config, deps.run);
  return runAudit({ project: ctx.project, config, scan: deps.scan ?? securityScanPort(config.security.scan_tool), run: deps.run, signal: deps.signal, dataDir: deps.dataDir });
}

export function auditHistory(ctx: ServiceContext, deps: Pick<AuditDeps, "dataDir"> = {}): AuditRecord[] {
  return listAudits(ctx.project, deps.dataDir);
}

/** One audit by id, or the newest. */
export function auditById(ctx: ServiceContext, id: string | undefined, deps: Pick<AuditDeps, "dataDir"> = {}): AuditRecord {
  const audit = findAudit(ctx.project, id, deps.dataDir);
  if (!audit) throw new ServiceError(id === undefined ? "No audits yet. Run `factory audit`." : `No audit ${id}. \`factory audit list\` shows them.`);
  return audit;
}

export interface FiledFinding {
  audit: AuditRecord;
  finding: Finding;
  issue: number;
}

/**
 * Open a GitHub issue for one finding of an audit (the newest, unless `audit` names one), so a run can
 * fix it. Refused on a public repository unless `allowPublic`: the issue would disclose a live
 * vulnerability to everyone. A finding is filed once, across audits: the plugin's ids are stable.
 */
export function fileAuditFinding(ctx: ServiceContext, ref: { audit?: string; finding: string; allowPublic?: boolean }, deps: AuditDeps = {}): FiledFinding {
  const audit = auditById(ctx, ref.audit, deps);
  const finding = audit.findings.find((f) => f.id === ref.finding);
  if (!finding) throw new ServiceError(`Audit ${audit.id} has no finding ${ref.finding}. \`factory audit show ${audit.id}\` lists them.`);
  const filed = filedIssue(ctx.project, finding.id, deps.dataDir);
  if (filed !== undefined) throw new ServiceError(`${finding.id} is already filed as issue #${filed}.`);
  const github = deps.github ?? ghPort(ctx.project, deps.run);
  if (!ref.allowPublic && github.repoVisibility() === "public") {
    throw new ServiceError(
      `${ctx.project.github_repo ?? ctx.project.name} is public: an issue would disclose this vulnerability to everyone. Report it privately with a security advisory instead, or pass --public if it is safe to share.`,
    );
  }
  const issue = github.createIssue({ title: issueTitle(ctx.project, finding), body: issueBody(ctx.project, audit, finding) });
  return { audit: recordFiled(ctx.project, audit, finding.id, issue, deps.dataDir), finding, issue };
}

/** The scan's text is about the repository, but written by its agents: no pings, no local paths. */
function clean(project: Project, text: string): string {
  return redactPaths(quietMentions(text), { roots: [project.repo_path] });
}

function issueTitle(project: Project, finding: Finding): string {
  const title = `Security: ${clean(project, finding.claim).replace(/\s+/g, " ").trim()}`;
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}

/** In the repo's issue template's shape (Why, What, Acceptance criteria), so a run can pick it up. */
function issueBody(project: Project, audit: AuditRecord, finding: Finding): string {
  const where = finding.file ? `\`${clean(project, finding.file)}${finding.line ? `:${finding.line}` : ""}\`` : "the repository";
  return [
    "### Why",
    "",
    `\`factory audit\` (the claude-security plugin) found and verified a ${isBlocking(finding) ? finding.severity : "minor"} security issue on the default branch at \`${audit.commit.slice(0, 12)}\`, in ${where}.`,
    "",
    clean(project, finding.claim),
    "",
    "### What",
    "",
    clean(project, finding.evidence),
    "",
    "### Acceptance criteria",
    "",
    `- [ ] The issue described above can no longer be reached in ${where}`,
    "- [ ] A test covers the case that was vulnerable",
    "",
  ].join("\n");
}
