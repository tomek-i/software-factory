import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { exportSnapshot, importChangeCount, importSnapshot, type CommandRunner, type ImportReport } from "@factory/core";
import { CliError, withProject } from "../context.js";

export interface SnapshotDeps {
  /** Where warnings go; the result goes to stdout. */
  warn?: (line: string) => void;
  run?: CommandRunner;
  now?: Date;
  host?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `factory export [file]`: this project's local state (queue, trust markers, finished runs, lessons,
 * draft progress) as JSON, to stdout or to `file`. Active runs stay: they belong to this machine.
 */
export function runExport(cwd: string, file: string | undefined, deps: SnapshotDeps = {}): string {
  const warn = deps.warn ?? ((line: string) => console.error(line));
  return withProject(
    cwd,
    ({ store, project, root }) => {
      const { snapshot, skipped } = exportSnapshot(store, project, { now: deps.now, host: deps.host });
      if (skipped.length > 0) {
        warn(`${plural(skipped.length, "active run")} not exported: finish or cancel them on this machine first (${skipped.join(", ")}).`);
      }
      const json = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (file === undefined) return json;

      const target = resolve(cwd, file);
      if (inside(root, target)) {
        warn(
          `warning: ${file} is inside the repository. The snapshot is as trusted as your factory database: never commit it. ` +
            `Keep it outside the repo, e.g. ${join(homedir(), `factory-${basename(root)}.json`)} or a cloud-sync folder.`,
        );
      }
      try {
        writeFileSync(target, json, { mode: 0o600 });
      } catch (err) {
        throw new CliError(`Could not write ${file}: ${(err as Error).message}`);
      }
      return [
        `Exported ${plural(snapshot.runs.length, "finished run")}, ${plural(snapshot.issues.length, "issue")} and ${plural(snapshot.lessons.length, "lesson")} to ${target}.`,
        "On the other machine: `factory import <file>`, then `factory sync`.",
      ].join("\n");
    },
    deps.run,
  );
}

/**
 * `factory import <file> [--dry-run]`: merge a snapshot from `factory export` into this project's
 * store. Only the file named here is read: importing sets trust markers, so nothing is picked up
 * from the repo on its own.
 */
export function runImport(cwd: string, file: string, options: { dryRun?: boolean } = {}, deps: SnapshotDeps = {}): string {
  return withProject(
    cwd,
    ({ store, project }) => {
      let text: string;
      try {
        text = readFileSync(resolve(cwd, file), "utf8");
      } catch (err) {
        throw new CliError(`Could not read ${file}: ${(err as Error).message}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new CliError(`${file} is not a factory snapshot: it is not JSON.`);
      }
      return describeImport(importSnapshot(store, project, data, { dryRun: options.dryRun }));
    },
    deps.run,
  );
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function describeImport(report: ImportReport): string {
  const from = `the snapshot from ${report.header.host || "an unnamed machine"}, exported ${report.header.exported_at}`;
  if (importChangeCount(report) === 0) {
    return [`Nothing to import: this database already has everything in ${from}.`, ...notes(report)].join("\n");
  }
  const verb = report.dryRun ? "Would add or change" : "Imported";
  const lines = [`${verb} from ${from}:`];
  const row = (label: string, parts: (string | false)[]) => {
    const kept = parts.filter((p): p is string => !!p);
    if (kept.length > 0) lines.push(`  ${label}: ${kept.join(", ")}`);
  };
  const numbers = (list: number[]) => list.map((n) => `#${n}`).join(" ");
  row("runs", [report.runs.added.length > 0 && `${report.runs.added.length} added`]);
  row("run events", [report.run_events > 0 && `${report.run_events} added`]);
  row("decisions", [report.decisions > 0 && `${report.decisions} added`]);
  row("agent runs", [report.agent_runs > 0 && `${report.agent_runs} added`]);
  row("issues", [
    report.issues.added.length > 0 && `${report.issues.added.length} added (${numbers(report.issues.added)})`,
    report.issues.queued.length > 0 && `${report.issues.queued.length} queued (${numbers(report.issues.queued)})`,
    report.issues.created_by_factory.length > 0 && `${report.issues.created_by_factory.length} claimed as opened by the factory, for GitHub to confirm (${numbers(report.issues.created_by_factory)})`,
  ]);
  row("lessons", [report.lessons.added > 0 && `${report.lessons.added} added`, report.lessons.decided > 0 && `${report.lessons.decided} decided`]);
  row("draft issues", [report.draft_issues > 0 && `${report.draft_issues} added`]);
  row("finished drafts", [report.drafts_done > 0 && `${report.drafts_done} added`]);
  lines.push(...notes(report));
  if (report.dryRun) lines.push("", "Nothing was written (--dry-run).");
  else if (report.issues.added.length > 0 || report.issues.queued.length > 0 || report.issues.created_by_factory.length > 0) {
    lines.push("", "Run `factory sync` to refresh the issues from GitHub.");
  }
  return lines.join("\n");
}

/** What was left out, whether or not anything changed. */
function notes(report: ImportReport): string[] {
  const lines: string[] = [];
  if (report.runs.present > 0) lines.push(`${plural(report.runs.present, "run")} already here, left as they are.`);
  if (report.lessons.missing_run > 0) lines.push(`${plural(report.lessons.missing_run, "lesson")} skipped: their run is not in this database.`);
  if (report.agent_run_conflicts.length > 0) {
    lines.push(`${plural(report.agent_run_conflicts.length, "agent run")} skipped: the id is already used here (${report.agent_run_conflicts.join(", ")}).`);
  }
  return lines;
}
