import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { isBlocking, parseVerdict, VerdictParseError, type Finding, type VerdictKind } from "@factory/shared";
import { acceptanceCount, readAcceptanceRecord, type CriterionResult } from "../pipeline/acceptance.js";
import { refutedFindings, runDirOf } from "../pipeline/driver.js";
import type { Project, Run, Store } from "../store/store.js";
import { ServiceError } from "./errors.js";
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
export function listRunFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listRunFiles(join(dir, entry.name), path));
    else out.push(path);
  }
  return out.sort();
}

/** `<folder>-N/<name>` of the highest N (numerically) that has one, e.g. `spec-2/critic.md`. */
export function latestRoundFile(files: string[], folder: "round" | "spec", name: string): string | undefined {
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
export function latestChecks(files: string[]): string | undefined {
  return latestRoundFile(files, "round", "checks.md");
}

/** The file list as error messages show it: indented, unstyled. */
function plainFileList(files: string[]): string {
  return files.length ? files.map((f) => `  ${f}`).join("\n") : "  (none)";
}

/**
 * The run-folder-relative path `file` names, or a ServiceError. Lexical only: `\` counts as a
 * separator on every OS, and anything that would leave the run folder (`..`, absolute or drive
 * paths) is refused. Short names such as `triage` or `checks` name the latest such file.
 */
export function resolveInRunDir(runDir: string, file: string, files: string[]): string {
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
      throw new ServiceError(`${missing}. Files in the run folder:\n${plainFileList(files)}`);
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
    throw new ServiceError(`"${file}" is outside the run folder; give a path inside it, e.g. triage.md or round-1/checks.md.`);
  }
  return normalised;
}

/** One section of the overview, about one file of the run folder. */
export type OverviewSection =
  /** A verdict file: the header value that says the most, its summary and, for reviews, what blocks. */
  | { kind: "verdict"; path: string; key: string; value: string; summary: string[]; blocking: Finding[]; refuted: number }
  /** A verdict file that does not parse: the first problem. */
  | { kind: "unparsed"; path: string; problem: string }
  /** The capture report: the items of its summary. */
  | { kind: "capture"; path: string; summary: string[] }
  /** The acceptance lens's result: each criterion with its status and evidence, and the count line. */
  | { kind: "acceptance"; path: string; count: string; criteria: CriterionResult[] };

export interface RunOverview {
  run: Run;
  /** The synced issue's title, when the run has an issue and it is synced. */
  issueTitle?: string;
  runDir: string;
  /** Whether the run folder exists yet; without it there are no files or sections. */
  hasRunDir: boolean;
  /** Every file in the run folder, sorted, `/`-separated. */
  files: string[];
  /** In the order to show them. */
  sections: OverviewSection[];
}

function sectionsOf(runDir: string, files: string[]): OverviewSection[] {
  const sections: OverviewSection[] = [];
  const unparsed = (path: string, err: VerdictParseError): OverviewSection => ({ kind: "unparsed", path, problem: err.problems[0] ?? err.message });

  /** A verdict file's header value and summary, when the file exists. */
  const summarise = (path: string | undefined, kind: VerdictKind, key: string) => {
    if (!path || !files.includes(path)) return;
    try {
      const verdict = parseVerdict(kind, readFileSync(join(runDir, path), "utf8"));
      sections.push({ kind: "verdict", path, key, value: String((verdict.header as Record<string, unknown>)[key]), summary: verdict.summary, blocking: [], refuted: 0 });
    } catch (err) {
      if (!(err instanceof VerdictParseError)) throw err;
      sections.push(unparsed(path, err));
    }
  };
  const checks = latestChecks(files);
  for (const { kind, key, path } of VERDICTS) summarise(path(files), kind, key);

  // The reviews of the latest gated round, each lens with its verdict and the findings that block,
  // then the verifier's judgement of those: the findings it confirmed and how many it refuted.
  const round = checks?.split("/")[0];
  // The acceptance lens is shown per criterion from the engine's record rather than as a review.
  const acceptance = round ? readAcceptanceRecord(join(runDir, round)) : undefined;
  if (acceptance) {
    sections.push({ kind: "acceptance", path: `${round}/acceptance.json`, count: acceptanceCount(acceptance.criteria), criteria: acceptance.criteria });
  }
  const judged = files.filter(
    (f) => round && ((f.startsWith(`${round}/review-`) && f.endsWith(".md") && !(acceptance && f === `${round}/review-acceptance.md`)) || f === `${round}/verify.md`),
  );
  for (const path of judged) {
    try {
      const kind = path.endsWith("/verify.md") ? "verify" : "review";
      const verdict = parseVerdict(kind, readFileSync(join(runDir, path), "utf8"));
      sections.push({
        kind: "verdict",
        path,
        key: "VERDICT",
        value: verdict.header.VERDICT,
        summary: verdict.summary,
        blocking: verdict.findings.filter(isBlocking),
        refuted: kind === "verify" ? refutedFindings(verdict.body).length : 0,
      });
    } catch (err) {
      if (!(err instanceof VerdictParseError)) throw err;
      sections.push(unparsed(path, err));
    }
  }

  // The capture stage's report: its summary says what was shot, new browser errors and the upload.
  const capture = latestRoundFile(files, "round", "capture-report.md");
  if (capture) {
    const text = readFileSync(join(runDir, capture), "utf8");
    const summary = /^## Summary\s*$([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/m.exec(text)?.[1] ?? "";
    sections.push({ kind: "capture", path: capture, summary: summary.split(/\r?\n/).flatMap((l) => /^[-*]\s+(.+)$/.exec(l.trim())?.[1] ?? []) });
  }

  // The merge stage: the quality gate again after merging the default branch in, and the approver's call.
  summarise(round && `${round}/resync/checks.md`, "checks", "GATE");
  summarise("approval.md", "approver", "DECISION");
  // After the merge: what the learner made of the run (its lessons wait in `factory lessons`).
  summarise("learn.md", "learn", "LESSONS");
  return sections;
}

/** A run's overview: its row, issue title, the latest verdicts of its run folder and its files. Read-only. */
export function runOverview(store: Store, project: Project, ref: string): RunOverview {
  const run = findRun(store, project, ref);
  const runDir = runDirOf(project.repo_path, run.id);
  const files = listRunFiles(runDir);
  const issueTitle = run.issue_number ? store.getIssue(project.id, run.issue_number)?.title : undefined;
  const hasRunDir = existsSync(runDir);
  return { run, issueTitle, runDir, hasRunDir, files, sections: hasRunDir ? sectionsOf(runDir, files) : [] };
}

/** One file of a run folder, by path or short name (see resolveInRunDir), exactly as it is on disk. */
export function runFile(store: Store, project: Project, ref: string, file: string): { run: Run; path: string; text: string } {
  const run = findRun(store, project, ref);
  const runDir = runDirOf(project.repo_path, run.id);
  const files = listRunFiles(runDir);
  const path = resolveInRunDir(runDir, file, files);
  const full = join(runDir, path);
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new ServiceError(`No file "${path}" in the run folder of ${run.id}. Files there:\n${plainFileList(files)}`);
  }
  return { run, path, text: readFileSync(full, "utf8") };
}
