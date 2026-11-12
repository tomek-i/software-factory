import { basename } from "node:path";
import type { CaptureResult, PageCapture, Shot } from "./capture.js";

/** What the capture stage ended with: the capture itself and where its media went. */
export interface CaptureOutcome {
  result?: CaptureResult;
  /** Why the capture agent planned nothing: the change shows nothing in the app after all. */
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
  /** False when there was no before to compare with (a new screen, or the before app failed). */
  compared: boolean;
}

/**
 * Errors only the after app has, per page and width. With no before shot every after error counts:
 * either the screen is new, or nothing shows the error was already there.
 */
export function newErrors(pages: PageCapture[]): NewErrors[] {
  return pages.flatMap((page) =>
    page.after.flatMap((shot) => {
      const before = page.before?.find((b) => b.width === shot.width);
      const old = new Set(before?.signals ?? []);
      const errors = [...new Set(shot.signals.filter((s) => !old.has(s)))];
      return errors.length ? [{ page: page.name, width: shot.width, errors, compared: before !== undefined }] : [];
    }),
  );
}

const fileName = (shot: Shot | undefined) => (shot?.file ? basename(shot.file) : undefined);

function walkthroughLine(result: CaptureResult): string | undefined {
  const w = result.walkthrough;
  if (!w) return undefined;
  if (w.problem) return `walkthrough stopped after ${w.ran} step(s): ${w.problem}${w.video ? " (the video shows how far it got)" : ""}`;
  return `walkthrough recorded (${w.ran} steps)`;
}

/** `capture-report.md`: everything the capture stage did and found, for `factory show`. */
export function renderCaptureReport(outcome: CaptureOutcome): string {
  const { result } = outcome;
  const lines = ["# Capture", "", "## Summary"];
  if (outcome.skipped) lines.push(`- no screenshots: ${outcome.skipped}`);
  else if (outcome.problem || !result || result.status !== "captured") {
    lines.push(`- screenshots could not be taken: ${outcome.problem ?? result?.problem ?? "unknown reason"}`);
  } else {
    const existing = result.pages.filter((p) => p.before).length;
    lines.push(`- ${result.pages.length} page(s) at ${[...new Set(result.pages.flatMap((p) => p.after.map((s) => s.width)))].join(" and ")} px; before shots of ${existing} existing screen(s)`);
    const fresh = newErrors(result.pages);
    const count = fresh.reduce((n, e) => n + e.errors.length, 0);
    lines.push(count ? `- ${count} new browser error(s), see New errors` : "- no new browser errors");
    const walk = walkthroughLine(result);
    if (walk) lines.push(`- ${walk}`);
  }
  if (outcome.urls) lines.push(`- media uploaded (${Object.keys(outcome.urls).length} files)`);
  if (outcome.uploadProblem) lines.push(`- media could not be uploaded: ${outcome.uploadProblem}`);

  if (result?.status === "captured") {
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
      for (const s of w.screenshots) lines.push(`- screenshot: ${basename(s)}`);
      for (const s of [...new Set(w.signals)]) lines.push(`- error: ${s}`);
    }
  }
  const notes = [
    ...(result?.notes ?? []),
    ...(result?.beforeProblem ? [`no before shots: ${result.beforeProblem}`] : []),
    ...(outcome.restored?.length ? [`the app left changes in the worktree, which were undone: ${outcome.restored.join(", ")}`] : []),
  ];
  if (notes.length) lines.push("", "## Notes", ...notes.map((n) => `- ${n}`));
  return `${lines.join("\n")}\n`;
}

/** Text from the app (error messages) as inline code, so GitHub renders none of it as markup. */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\r?\n/g, " ")}\``;
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
 * walkthrough video, or why there are none. Undefined when capture did not run (no UI change).
 */
export function screenshotsSection(outcome: CaptureOutcome, runId: string): string | undefined {
  const { result } = outcome;
  const where = `They are in the run folder: \`factory show ${runId} capture\`.`;
  if (outcome.skipped) return `## Screenshots\nNo screenshots: ${outcome.skipped}`;
  if (outcome.problem || !result || result.status !== "captured") {
    return `## Screenshots\nScreenshots could not be taken: ${outcome.problem ?? result?.problem ?? "unknown reason"}`;
  }
  if (!outcome.urls) return `## Screenshots\nScreenshots were taken but could not be uploaded: ${outcome.uploadProblem ?? "unknown reason"}. ${where}`;
  const urls = outcome.urls;
  const rows = result.pages.flatMap((page) =>
    page.after.map((shot) => {
      const before = page.before?.find((b) => b.width === shot.width);
      const beforeCell = page.screen === "new" ? "_new screen_" : (image(urls, before, `${page.name} before, ${shot.width}px`) ?? "_not captured_");
      const afterCell = image(urls, shot, `${page.name} after, ${shot.width}px`) ?? `_failed: ${cell(shot.error ?? "no screenshot")}_`;
      return `| **${page.name}** \`${cell(page.path)}\` ${shot.width}px | ${beforeCell} | ${afterCell} |`;
    }),
  );
  const parts = ["## Screenshots", ["| Page | Before | After |", "|---|---|---|", ...rows].join("\n")];
  const w = result.walkthrough;
  const video = w?.video ? urls[basename(w.video)] : undefined;
  if (video) parts.push(`**Walkthrough video:** [walkthrough.webm](${video})`);
  if (w?.problem) parts.push(`The walkthrough stopped early: ${code(w.problem)}`);
  const fresh = newErrors(result.pages);
  if (fresh.length) {
    parts.push(`**New browser errors**\n${fresh.flatMap((e) => e.errors.map((s) => `- ${e.page} at ${e.width}px: ${code(s)}`)).join("\n")}`);
  }
  const notes = [...result.notes, ...(result.beforeProblem ? [`no before shots: ${result.beforeProblem}`] : [])];
  if (notes.length) parts.push(notes.map((n) => `- ${n}`).join("\n"));
  return parts.join("\n\n");
}
