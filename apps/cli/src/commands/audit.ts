import { auditById, auditDir, auditHistory, auditProject, fileAuditFinding, type AuditPort, type AuditRecord, type CommandRunner, type SecurityScanPort } from "@factory/core";
import { withProject, withProjectAsync } from "../context.js";
import { plain, type Style } from "../style.js";

export interface AuditDeps {
  run?: CommandRunner;
  scan?: SecurityScanPort;
  github?: AuditPort;
  signal?: AbortSignal;
  dataDir?: string;
  style?: Style;
  print?: (line: string) => void;
}

/** `factory audit`: scan the whole default branch with the claude-security plugin. */
export async function runAuditNow(cwd: string, deps: AuditDeps = {}): Promise<string> {
  const style = deps.style ?? plain;
  (deps.print ?? console.log)(style.detail("Scanning the default branch with the claude-security plugin. This takes minutes, longer on a big repository."));
  return withProjectAsync(
    cwd,
    async (ctx) => {
      const audit = await auditProject(ctx, deps);
      return auditText(audit, style, auditDir(ctx.project, audit, deps.dataDir));
    },
    deps.run,
  );
}

/** `factory audit list`: the project's audits, newest first. */
export function runAuditList(cwd: string, deps: AuditDeps = {}): string {
  const style = deps.style ?? plain;
  return withProject(
    cwd,
    (ctx) => {
      const audits = auditHistory(ctx, deps);
      if (!audits.length) return "No audits yet. Run `factory audit`.";
      return audits.map((a) => `${style.detail(a.id)}  ${a.commit.slice(0, 7)}  ${statusText(a, style)}`).join("\n");
    },
    deps.run,
  );
}

/** `factory audit show [audit]`: one audit's findings, the newest by default. */
export function runAuditShow(cwd: string, id: string | undefined, deps: AuditDeps = {}): string {
  const style = deps.style ?? plain;
  return withProject(
    cwd,
    (ctx) => {
      const audit = auditById(ctx, id, deps);
      return auditText(audit, style, auditDir(ctx.project, audit, deps.dataDir));
    },
    deps.run,
  );
}

/** `factory audit file <finding>`: open a GitHub issue for one finding. */
export function runAuditFile(cwd: string, finding: string, options: { audit?: string; public?: boolean }, deps: AuditDeps = {}): string {
  return withProject(
    cwd,
    (ctx) => {
      const filed = fileAuditFinding(ctx, { audit: options.audit, finding, allowPublic: options.public }, deps);
      return `Filed ${filed.finding.id} as issue #${filed.issue}. Queue it with \`factory queue ${filed.issue}\` to have the factory fix it.`;
    },
    deps.run,
  );
}

function statusText(audit: AuditRecord, style: Style): string {
  if (audit.status !== "complete") return style.warning(`${audit.status}: ${audit.problem ?? ""}`.trim());
  const blocking = audit.findings.filter((f) => f.severity === "critical" || f.severity === "major").length;
  return audit.findings.length ? style.attention(`${audit.findings.length} finding${audit.findings.length === 1 ? "" : "s"}, ${blocking} critical or major`) : style.success("no findings");
}

function auditText(audit: AuditRecord, style: Style, dir: string): string {
  const lines = [`Audit ${style.detail(audit.id)} of ${audit.commit.slice(0, 12)} (effort ${audit.effort}): ${statusText(audit, style)}`];
  for (const note of audit.notes) lines.push(style.warning(`note: ${note}`));
  for (const f of audit.findings) {
    const where = f.file ? ` ${style.detail(`${f.file}${f.line ? `:${f.line}` : ""}`)}` : "";
    const filed = audit.filed[f.id] === undefined ? "" : style.detail(` (issue #${audit.filed[f.id]})`);
    lines.push("", `${f.severity.toUpperCase()}  ${f.claim}${where}${filed}`, `  ${style.detail(f.id)}`);
  }
  const open = audit.findings.filter((f) => audit.filed[f.id] === undefined);
  if (open.length) lines.push("", style.hint(`File one as an issue: \`factory audit file ${open[0]!.id}\`. The full report: ${dir}`));
  else if (audit.status === "complete") lines.push("", style.detail(`The full report: ${dir}`));
  return lines.join("\n");
}
