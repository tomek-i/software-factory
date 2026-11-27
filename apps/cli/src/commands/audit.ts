import {
  auditById,
  auditDir,
  auditHistory,
  auditProject,
  fileAuditFinding,
  filedIssue,
  type AuditPort,
  type AuditRecord,
  type CommandRunner,
  type SecurityScanPort,
} from "@factory/core";
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

/** `factory audit`: scan the whole default branch with the claude-security plugin. `complete` is false when it couldn't scan. */
export async function runAuditNow(cwd: string, deps: AuditDeps = {}): Promise<{ message: string; complete: boolean }> {
  const style = deps.style ?? plain;
  return withProjectAsync(
    cwd,
    async (ctx) => {
      (deps.print ?? console.log)(style.detail("Scanning the default branch with the claude-security plugin. This takes minutes, longer on a big repository."));
      const audit = await auditProject(ctx, deps);
      const message = auditText(audit, style, auditDir(ctx.project, audit, deps.dataDir), (f) => filedIssue(ctx.project, f, deps.dataDir), true);
      return { message, complete: audit.status === "complete" };
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
      const newest = auditHistory(ctx, deps)[0]?.id === audit.id;
      return auditText(audit, style, auditDir(ctx.project, audit, deps.dataDir), (f) => filedIssue(ctx.project, f, deps.dataDir), newest);
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

/** `newest` leaves `--audit` out of the hint, since `factory audit file` defaults to the newest audit. */
function auditText(audit: AuditRecord, style: Style, dir: string, filedOf: (finding: string) => number | undefined, newest: boolean): string {
  const lines = [`Audit ${style.detail(audit.id)} of ${audit.commit.slice(0, 12)} (effort ${audit.effort}): ${statusText(audit, style)}`];
  for (const note of audit.notes) lines.push(style.warning(`note: ${note}`));
  for (const f of audit.findings) {
    const where = f.file ? ` ${style.detail(`${f.file}${f.line ? `:${f.line}` : ""}`)}` : "";
    const issue = filedOf(f.id);
    const filed = issue === undefined ? "" : style.detail(` (issue #${issue})`);
    // The evidence goes into the issue as written, so it is shown here before anyone files it.
    const evidence = f.evidence.split(/\r?\n/).map((l) => `  ${l}`);
    lines.push("", `${f.severity.toUpperCase()}  ${f.claim}${where}${filed}`, `  ${style.detail(f.id)}`, ...evidence);
  }
  const open = audit.findings.filter((f) => filedOf(f.id) === undefined);
  const from = newest ? "" : ` --audit ${audit.id}`;
  if (open.length) lines.push("", style.hint(`File one as an issue: \`factory audit file ${open[0]!.id}${from}\`. The full report: ${dir}`));
  else if (audit.status === "complete") lines.push("", style.detail(`The full report: ${dir}`));
  return lines.join("\n");
}
