import { runFile, runOverview, type RunOverview } from "@factory/core";
import { withProject } from "../context.js";
import { plain, type Style } from "../style.js";
import type { RunDeps } from "./runs.js";

function fileList(files: string[], style: Style): string {
  return files.length ? files.map((f) => `  ${style.detail(f)}`).join("\n") : "  (none)";
}

function overview({ run, issueTitle, runDir, hasRunDir, files, sections }: RunOverview, style: Style): string {
  const lines = [`Run ${style.detail(run.id)}`, `  state:   ${style.state(run.state)}`];
  if (run.waiting_gate) lines.push(`  waiting: ${style.attention(`${run.waiting_gate} gate`)}`);
  // Times merging the default branch sent the run back to the builder, apart from review rounds (loops.max_resyncs).
  if (run.resync_rounds) lines.push(`  resyncs: ${run.resync_rounds}`);
  lines.push(
    `  issue:   ${run.issue_number ? `#${run.issue_number} ${issueTitle ?? run.title}` : `- ${run.title}`}`,
    `  branch:  ${run.branch ? style.detail(run.branch) : "-"}`,
    `  PR:      ${run.pr_number ? style.detail(`#${run.pr_number}`) : "-"}`,
  );

  if (!hasRunDir) {
    lines.push("", `No files yet: ${style.detail(runDir)} does not exist.`);
    return lines.join("\n");
  }

  const summary = (items: string[]) => (items.length ? items.map((s) => `  - ${s}`) : ["  (no summary)"]);
  for (const section of sections) {
    lines.push("");
    switch (section.kind) {
      // `path (KEY: VALUE)`: the path is the section's title, and the value is coloured by meaning.
      case "verdict":
        lines.push(`${style.title(section.path)} (${section.key}: ${style.verdict(section.value)})`, ...summary(section.summary));
        for (const f of section.blocking) {
          lines.push(`  ${f.severity}: ${f.claim}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
        }
        if (section.refuted) lines.push(`  refuted: ${section.refuted}`);
        break;
      case "unparsed":
        lines.push(`${style.title(section.path)} (could not be parsed: ${section.problem})`);
        break;
      case "capture":
        lines.push(style.title(section.path), ...summary(section.summary));
    }
  }

  lines.push("", `Files in ${style.detail(runDir)}:`, fileList(files, style), "", `Show one with \`factory show ${run.id} <file>\`, e.g. \`factory show ${run.id} triage\`.`);
  return lines.join("\n");
}

/**
 * `factory show <run> [file]`: a run's overview, or one file from its run folder. Read-only. Only
 * the overview is styled; a file comes back exactly as it is on disk.
 */
export function runShow(cwd: string, ref: string, file?: string, deps: Pick<RunDeps, "run" | "style"> = {}): string {
  const style = deps.style ?? plain;
  return withProject(
    cwd,
    ({ store, project }) => {
      if (file === undefined) return overview(runOverview(store, project, ref), style);
      // The raw file, never styled: it may be piped or copied.
      return runFile(store, project, ref, file).text;
    },
    deps.run,
  );
}
