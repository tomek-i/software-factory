import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { refutedFindings, runDirOf, type CommandRunner, type Run } from "@factory/core";
import { isBlocking, parseVerdict, VerdictParseError, type VerdictKind } from "@factory/shared";
import { CliError, withProject } from "../context.js";
import { findRun } from "./runs.js";

/** Verdict files the overview summarises, with the header that says the most about each. */
const VERDICTS: { kind: VerdictKind; key: string; path: (files: string[]) => string | undefined }[] = [
  { kind: "triage", key: "DECISION", path: () => "triage.md" },
  { kind: "refine", key: "STATUS", path: (files) => latestRoundFile(files, "spec", "refine.md") },
  { kind: "critic", key: "VERDICT", path: (files) => latestRoundFile(files, "spec", "critic.md") },
  { kind: "build", key: "STATUS", path: () => "build.md" },
  { kind: "checks", key: "GATE", path: (files) => latestChecks(files) },
];

/** Every file under dir, as sorted `/`-separated paths relative to it. */
function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), path));
    else out.push(path);
  }
  return out.sort();
}

/** `<folder>-N/<name>` of the highest N (numerically) that has one, e.g. `spec-2/critic.md`. */
function latestRoundFile(files: string[], folder: "round" | "spec", name: string): string | undefined {
  let best: { round: number; path: string } | undefined;
  for (const path of files) {
    const [dir, file] = path.split("/");
    const match = new RegExp(`^${folder}-(\\d+)$`).exec(dir!);
    if (!match || file !== name || path.split("/").length !== 2) continue;
    const round = Number(match[1]);
    if (!best || round > best.round) best = { round, path };
  }
  return best?.path;
}

/** `round-N/checks.md` of the highest round N (numerically) that has one. */
function latestChecks(files: string[]): string | undefined {
  return latestRoundFile(files, "round", "checks.md");
}

function fileList(files: string[]): string {
  return files.length ? files.map((f) => `  ${f}`).join("\n") : "  (none)";
}

/**
 * The run-folder-relative path `file` names, or a CliError. Lexical only: `\` counts as a separator
 * on every OS, and anything that would leave the run folder (`..`, absolute or drive paths) is refused.
 */
function resolveInRunDir(runDir: string, file: string, files: string[]): string {
  const short: Record<string, string | undefined> = {
    triage: "triage.md",
    refine: latestRoundFile(files, "spec", "refine.md"),
    critic: latestRoundFile(files, "spec", "critic.md"),
    build: "build.md",
    checks: latestChecks(files),
    capture: latestRoundFile(files, "round", "capture-report.md"),
    approval: "approval.md",
    learn: "learn.md",
  };
  if (Object.hasOwn(short, file)) {
    const path = short[file];
    if (!path) {
      const missing =
        file === "checks" ? "No round has a checks.md yet" : file === "capture" ? "No round has a capture-report.md yet" : `No spec round has a ${file}.md yet`;
      throw new CliError(`${missing}. Files in the run folder:\n${fileList(files)}`);
    }
    return path;
  }
  const slashed = file.replace(/\\/g, "/");
  const normalised = posix.normalize(slashed);
  const outside =
    posix.isAbsolute(slashed) ||
    win32.isAbsolute(file) ||
    /^[a-zA-Z]:/.test(slashed) ||
    normalised === ".." ||
    normalised.startsWith("../");
  const rel = relative(runDir, resolve(runDir, normalised));
  if (outside || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CliError(`"${file}" is outside the run folder; give a path inside it, e.g. triage.md or round-1/checks.md.`);
  }
  return normalised;
}

function overview(run: Run, issueTitle: string | undefined, runDir: string, files: string[]): string {
  const lines = [`Run ${run.id}`, `  state:   ${run.state}`];
  if (run.waiting_gate) lines.push(`  waiting: ${run.waiting_gate} gate`);
  lines.push(
    `  issue:   ${run.issue_number ? `#${run.issue_number} ${issueTitle ?? run.title}` : `- ${run.title}`}`,
    `  branch:  ${run.branch ?? "-"}`,
    `  PR:      ${run.pr_number ? `#${run.pr_number}` : "-"}`,
  );

  if (!existsSync(runDir)) {
    lines.push("", `No files yet: ${runDir} does not exist.`);
    return lines.join("\n");
  }

  /** A verdict file's header value and summary, when the file exists. */
  const summarise = (path: string | undefined, kind: VerdictKind, key: string) => {
    if (!path || !files.includes(path)) return;
    lines.push("");
    try {
      const verdict = parseVerdict(kind, readFileSync(join(runDir, path), "utf8"));
      lines.push(`${path} (${key}: ${String((verdict.header as Record<string, unknown>)[key])})`);
      lines.push(...(verdict.summary.length ? verdict.summary.map((s) => `  - ${s}`) : ["  (no summary)"]));
    } catch (err) {
      if (!(err instanceof VerdictParseError)) throw err;
      lines.push(`${path} (could not be parsed: ${err.problems[0] ?? err.message})`);
    }
  };
  const checks = latestChecks(files);
  for (const { kind, key, path } of VERDICTS) summarise(path(files), kind, key);

  // The reviews of the latest gated round, each lens with its verdict and the findings that block,
  // then the verifier's judgement of those: the findings it confirmed and how many it refuted.
  const round = checks?.split("/")[0];
  const judged = files.filter((f) => round && ((f.startsWith(`${round}/review-`) && f.endsWith(".md")) || f === `${round}/verify.md`));
  for (const path of judged) {
    lines.push("");
    try {
      const kind = path.endsWith("/verify.md") ? "verify" : "review";
      const verdict = parseVerdict(kind, readFileSync(join(runDir, path), "utf8"));
      lines.push(`${path} (VERDICT: ${verdict.header.VERDICT})`);
      lines.push(...(verdict.summary.length ? verdict.summary.map((s) => `  - ${s}`) : ["  (no summary)"]));
      for (const f of verdict.findings.filter(isBlocking)) {
        lines.push(`  ${f.severity}: ${f.claim}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
      }
      const refuted = kind === "verify" ? refutedFindings(verdict.body).length : 0;
      if (refuted) lines.push(`  refuted: ${refuted}`);
    } catch (err) {
      if (!(err instanceof VerdictParseError)) throw err;
      lines.push(`${path} (could not be parsed: ${err.problems[0] ?? err.message})`);
    }
  }

  // The capture stage's report: its summary says what was shot, new browser errors and the upload.
  const capture = latestRoundFile(files, "round", "capture-report.md");
  if (capture) {
    const text = readFileSync(join(runDir, capture), "utf8");
    const summary = /^## Summary\s*$([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/m.exec(text)?.[1] ?? "";
    const items = summary.split(/\r?\n/).flatMap((l) => /^[-*]\s+(.+)$/.exec(l.trim())?.[1] ?? []);
    lines.push("", capture, ...(items.length ? items.map((s) => `  - ${s}`) : ["  (no summary)"]));
  }

  // The merge stage: the quality gate again after merging the default branch in, and the approver's call.
  summarise(round && `${round}/resync/checks.md`, "checks", "GATE");
  summarise("approval.md", "approver", "DECISION");
  // After the merge: what the learner made of the run (its lessons wait in `factory lessons`).
  summarise("learn.md", "learn", "LESSONS");

  lines.push("", `Files in ${runDir}:`, fileList(files), "", `Show one with \`factory show ${run.id} <file>\`, e.g. \`factory show ${run.id} triage\`.`);
  return lines.join("\n");
}

/** `factory show <run> [file]`: a run's overview, or one file from its run folder. Read-only. */
export function runShow(cwd: string, ref: string, file?: string, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project }) => {
      const target = findRun(store, project, ref);
      const runDir = runDirOf(project.repo_path, target.id);
      const files = listFiles(runDir);
      if (file === undefined) {
        const issue = target.issue_number ? store.getIssue(project.id, target.issue_number) : undefined;
        return overview(target, issue?.title, runDir, files);
      }

      const path = resolveInRunDir(runDir, file, files);
      const full = join(runDir, path);
      if (!existsSync(full) || !statSync(full).isFile()) {
        throw new CliError(`No file "${path}" in the run folder of ${target.id}. Files there:\n${fileList(files)}`);
      }
      return readFileSync(full, "utf8");
    },
    run,
  );
}
