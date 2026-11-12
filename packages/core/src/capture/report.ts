import { basename } from "node:path";
import type { CaptureResult, PageCapture, Shot } from "./capture.js";

/** What the capture stage ended with: the capture itself and where its media went. */
export interface CaptureOutcome {
  result?: CaptureResult;
  /** Why nothing was shot although capture ran (the agent planned nothing, the worktree was not clean). */
  skipped?: string;
  /** Why there are no screenshots at all (no plan, the app did not start, no Playwright, ...). */
  problem?: string;
  /** Uploaded media: file name -> URL. */
  urls?: Record<string, string>;
  uploadProblem?: string;
  /** Files the app left behind in the run's worktree, which the engine restored. */
  restored?: string[];
}

/** The errors of one page at one width that the before app did not have. */
export interface NewErrors {
  page: string;
  width: number;
  errors: string[];
  /** False when there was no before to compare with (a new screen, or the before page did not load). */
  compared: boolean;
}

/**
 * An error as it is compared: a build's hashed chunk names (`main.3f9a1c2b.js`, `index-BkX9_2aQ.js`)
 * and cache-busting `?v=`/`?t=` values differ between two builds of the same code.
 */
export function comparable(signal: string): string {
  return signal
    .replace(/([.-])[A-Za-z0-9_]{8,}(?=\.(?:m?js|css|map|woff2?)\b)/g, "$1[hash]")
    .replace(/([?&](?:v|t)=)[^&\s)'"]*/g, "$1[v]");
}

/**
 * Errors only the after app has, per page and width. Without a before shot that loaded, every after
 * error counts: either the screen is new, or nothing shows the error was already there.
 */
export function newErrors(pages: PageCapture[]): NewErrors[] {
  return pages.flatMap((page) =>
    page.after.flatMap((shot) => {
      const found = page.before?.find((b) => b.width === shot.width);
      // A before page that failed to load says nothing about the errors it would have had.
      const before = found?.file ? found : undefined;
      const old = new Set((before?.signals ?? []).map(comparable));
      const errors = [...new Set(shot.signals.filter((s) => !old.has(comparable(s))))];
      return errors.length ? [{ page: page.name, width: shot.width, errors, compared: before !== undefined }] : [];
    }),
  );
}

/** The first line of a message; the rest (a server's log tail, git's output) stays in the report. */
function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]!.slice(0, 300);
}

const fileName = (shot: Shot | undefined) => (shot?.file ? basename(shot.file) : undefined);

function walkthroughLine(result: CaptureResult): string | undefined {
  const w = result.walkthrough;
  if (!w) return undefined;
  if (w.problem) return `walkthrough stopped after ${w.ran} step(s): ${firstLine(w.problem)}${w.video ? " (the video shows how far it got)" : ""}`;
  return `walkthrough recorded (${w.ran} steps)`;
}

/** `capture-report.md`: everything the capture stage did and found, for `factory show`. */
export function renderCaptureReport(outcome: CaptureOutcome): string {
  const { result } = outcome;
  const failed = !outcome.skipped && (outcome.problem !== undefined || result?.status !== "captured");
  const problem = outcome.problem ?? result?.problem ?? "unknown reason";
  const lines = ["# Capture", "", "## Summary"];
  if (outcome.skipped) lines.push(`- no screenshots: ${outcome.skipped}`);
  else if (failed) lines.push(`- screenshots could not be taken: ${firstLine(problem)}`);
  else if (result) {
    const existing = result.pages.filter((p) => p.before).length;
    lines.push(`- ${result.pages.length} page(s) at ${[...new Set(result.pages.flatMap((p) => p.after.map((s) => s.width)))].join(" and ")} px; before shots of ${existing} existing screen(s)`);
    const fresh = newErrors(result.pages);
    const count = fresh.reduce((n, e) => n + e.errors.length, 0);
    lines.push(count ? `- ${count} new browser error(s), see New errors` : "- no new browser errors");
    const walk = walkthroughLine(result);
    if (walk) lines.push(`- ${walk}`);
  }
  if (outcome.urls) lines.push(`- media uploaded (${Object.keys(outcome.urls).length} files)`);
  if (outcome.uploadProblem) lines.push(`- media could not be uploaded: ${firstLine(outcome.uploadProblem)}`);

  if (result?.status === "captured" && !outcome.problem) {
    lines.push("", "## Pages", "", "| Page | Path | Screen | Width | Before | After |", "|---|---|---|---|---|---|");
    for (const page of result.pages) {
      for (const shot of page.after) {
        const before = page.before?.find((b) => b.width === shot.width);
        const beforeCell = page.screen === "new" ? "new screen" : (fileName(before) ?? (before?.error ? `failed: ${before.error}` : "-"));
        const afterCell = fileName(shot) ?? `failed: ${shot.error ?? "no screenshot"}`;
        lines.push(`| ${page.name} | \`${page.path}\` | ${page.screen} | ${shot.width} | ${cell(beforeCell)} | ${cell(afterCell)} |`);
      }
    }
    const fresh = newErrors(result.pages);
    if (fresh.length) {
      lines.push("", "## New errors", "Console errors, page errors, failed requests and 4xx/5xx responses the default branch did not have.");
      for (const e of fresh) lines.push("", `### ${e.page} at ${e.width}px${e.compared ? "" : " (nothing to compare with)"}`, ...e.errors.map((s) => `- ${s}`));
    }
    const w = result.walkthrough;
    if (w) {
      lines.push("", "## Walkthrough", `- ${walkthroughLine(result)}`);
      if (w.video) lines.push(`- video: ${basename(w.video)}`);
      if (w.narrated) lines.push(`- narrated video: ${basename(w.narrated)}`);
      if (w.narrationProblem) lines.push(`- no narration: ${w.narrationProblem}`);
      for (const s of w.screenshots) lines.push(`- screenshot: ${basename(s)}`);
      for (const s of [...new Set(w.signals)]) lines.push(`- error: ${s}`);
    }
  }
  const notes = [
    ...(result?.notes ?? []),
    ...(result?.beforeProblem ? [`no before shots: ${firstLine(result.beforeProblem)}`] : []),
    ...(result?.warnings ?? []),
    ...(outcome.restored?.length ? [`the app left changes in the worktree, which were undone: ${outcome.restored.join(", ")}`] : []),
  ];
  if (notes.length) lines.push("", "## Notes", ...notes.map((n) => `- ${n}`));
  // Whole messages of more than one line, e.g. the end of the app's output when it did not start.
  const details = [...(failed ? [problem] : []), outcome.uploadProblem, result?.beforeProblem].filter((d): d is string => d !== undefined && d.trim().includes("\n"));
  if (details.length) lines.push("", "## Details", ...details.flatMap((d) => ["", "```text", d.trim().replace(/```/g, "'''"), "```"]));
  return `${lines.join("\n")}\n`;
}

/** Text from the app (error messages) as inline code, so GitHub renders none of it as markup. */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\r?\n/g, " ")}\``;
}

/**
 * A message for the PR: its first line only, as inline code. The rest (log tails, git output) can
 * hold local paths and environment values, and any of it could carry @mentions or markup.
 */
function brief(text: string): string {
  return code(firstLine(text));
}

/** A markdown table cell: no pipes or line breaks. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function image(urls: Record<string, string>, shot: Shot | undefined, alt: string): string | undefined {
  const name = fileName(shot);
  const url = name ? urls[name] : undefined;
  return url ? `<img src="${url}" alt="${alt}" width="360">` : undefined;
}

/**
 * The PR description's `## Screenshots`: a before/after table of the uploaded shots and the
 * walkthrough video, or why there are none. Every message in it is briefed (first line, inline code).
 */
export function screenshotsSection(outcome: CaptureOutcome, runId: string): string {
  const { result } = outcome;
  const where = `Details: \`factory show ${runId} capture\`.`;
  if (outcome.skipped) return `## Screenshots\nNo screenshots: ${brief(outcome.skipped)}`;
  if (outcome.problem || !result || result.status !== "captured") {
    return `## Screenshots\nScreenshots could not be taken: ${brief(outcome.problem ?? result?.problem ?? "unknown reason")}. ${where}`;
  }
  if (!outcome.urls) return `## Screenshots\nScreenshots were taken but could not be uploaded: ${brief(outcome.uploadProblem ?? "unknown reason")}. ${where}`;
  const urls = outcome.urls;
  const rows = result.pages.flatMap((page) =>
    page.after.map((shot) => {
      const before = page.before?.find((b) => b.width === shot.width);
      const beforeCell = page.screen === "new" ? "_new screen_" : (image(urls, before, `${page.name} before, ${shot.width}px`) ?? "_not captured_");
      const afterCell = image(urls, shot, `${page.name} after, ${shot.width}px`) ?? `failed: ${cell(brief(shot.error ?? "no screenshot"))}`;
      return `| **${page.name}** \`${cell(page.path)}\` ${shot.width}px | ${beforeCell} | ${afterCell} |`;
    }),
  );
  const parts = ["## Screenshots", ["| Page | Before | After |", "|---|---|---|", ...rows].join("\n")];
  const w = result.walkthrough;
  // The narrated video replaces the silent one when there is one; only one of them is uploaded.
  const shown = w?.narrated ?? w?.video;
  const video = shown ? urls[basename(shown)] : undefined;
  if (video) parts.push(`**Walkthrough video${w?.narrated ? " (narrated)" : ""}:** [${basename(shown!)}](${video})`);
  if (w?.narrationProblem) parts.push(`No narration: ${brief(w.narrationProblem)}`);
  if (w?.problem) parts.push(`The walkthrough stopped early: ${brief(w.problem)}`);
  const fresh = newErrors(result.pages);
  if (fresh.length) {
    parts.push(`**New browser errors**\n${fresh.flatMap((e) => e.errors.map((s) => `- ${e.page} at ${e.width}px: ${code(s)}`)).join("\n")}`);
  }
  const notes = [...result.notes.map((n) => `- ${n}`), ...(result.beforeProblem ? [`- no before shots: ${brief(result.beforeProblem)}`] : [])];
  if (notes.length) parts.push(notes.join("\n"));
  return parts.join("\n\n");
}
