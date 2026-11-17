import { isBlocking, type Finding, type ParsedVerdict, type ReviewLens } from "@factory/shared";
import { escapeRegExp, section } from "./shared.js";

/** The review lenses' findings and the verifier's judgement of them. */

export interface LensReview {
  lens: ReviewLens;
  verdict: ParsedVerdict<"review">;
}

/** A critical or major finding as the verifier sees it, with an id unique across all lenses. */
export interface BlockingFinding {
  lens: ReviewLens;
  finding: Finding;
}

/**
 * Every lens's blocking findings. Reviewers are told to start ids with their lens, but if two lenses
 * still use the same id, both get the lens in front so the verifier can name each one.
 */
export function blockingFindings(reviews: LensReview[]): BlockingFinding[] {
  const all = reviews.flatMap(({ lens, verdict }) => verdict.findings.filter(isBlocking).map((finding) => ({ lens, finding })));
  const count = new Map<string, number>();
  for (const { finding } of all) count.set(finding.id, (count.get(finding.id) ?? 0) + 1);
  return all.map(({ lens, finding }) => (count.get(finding.id)! > 1 ? { lens, finding: { ...finding, id: `${lens}/${finding.id}` } } : { lens, finding }));
}

/**
 * The verifier's `## Refuted` lines: `- <id>: <why>`, top-level bullets only (an indented bullet
 * belongs to the reason above it). Reviewers may use any text as an id, so the `known` ids are tried
 * first, longest first; otherwise the id is everything before the first ": ".
 */
export function refutedFindings(body: string, known: string[] = []): { id: string; reason: string }[] {
  const text = section(body, "refuted") ?? "";
  const ids = [...known].sort((a, b) => b.length - a.length);
  return text.split(/\r?\n/).flatMap((line) => {
    const item = /^[-*]\s+(.+)$/.exec(line)?.[1];
    if (!item) return [];
    for (const id of ids) {
      const match = new RegExp(`^\`?${escapeRegExp(id)}\`?\\s*:\\s*(.+)$`).exec(item);
      if (match) return [{ id, reason: match[1]!.trim() }];
    }
    const match = /^`?(.+?)`?\s*:\s+(.+)$/.exec(item);
    return match ? [{ id: match[1]!, reason: match[2]!.trim() }] : [];
  });
}

/**
 * The verifier must judge every blocking finding exactly once: confirmed (in its findings) or
 * refuted. It may confirm one finding of its own, `verifier-*`, when something tried to steer it.
 */
export function verifyProblems(verdict: ParsedVerdict<"verify">, blocking: BlockingFinding[]): string[] {
  const known = new Set(blocking.map((b) => b.finding.id));
  const confirmed = verdict.findings.map((f) => f.id);
  const refuted = refutedFindings(verdict.body, [...known]).map((r) => r.id);
  const problems: string[] = [];
  for (const f of verdict.findings) {
    if (!isBlocking(f)) problems.push(`confirmed finding ${f.id} must be critical or major; refute it if it is only minor`);
  }
  for (const id of confirmed) if (!known.has(id) && !id.startsWith("verifier-")) problems.push(`confirmed finding ${id} is not one of the findings to verify`);
  for (const id of refuted) if (!known.has(id)) problems.push(`refuted finding ${id} is not one of the findings to verify`);
  const judged = [...confirmed, ...refuted];
  const twice = [...new Set(judged.filter((id, i) => judged.indexOf(id) !== i))];
  if (twice.length) problems.push(`judged more than once: ${twice.join(", ")}`);
  const missing = [...known].filter((id) => !judged.includes(id));
  if (missing.length) problems.push(`not judged (confirm or refute each): ${missing.join(", ")}`);
  return problems;
}

/** Where a finding points, e.g. ` (src/a.ts:3)`. */
function findingPlace(f: Finding): string {
  return f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
}

/** The lines of each file a review comment may point at: added and context lines on the new side of a diff. */
export type DiffLines = Map<string, Set<number>>;

/**
 * The new-side lines of a unified diff (`git diff`), per file. Anything before the first
 * `diff --git` (such as the commit log in change.diff) is skipped. A deleted file has none, and
 * neither has a path git quotes (unusual characters): their findings go in the review's body.
 */
export function diffLines(diff: string): DiffLines {
  const lines: DiffLines = new Map();
  let file: Set<number> | undefined;
  let started = false;
  let next = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      if (line.startsWith("-")) {
        oldLeft--;
        continue;
      }
      file?.add(next++);
      newLeft--;
      if (!line.startsWith("+")) oldLeft--;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      started = true;
      file = undefined;
    } else if (started && line.startsWith("+++ b/")) {
      const name = line.slice("+++ b/".length).replace(/\t$/, "");
      file = lines.get(name) ?? new Set();
      lines.set(name, file);
    } else if (started) {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        next = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
    }
  }
  return lines;
}

/** A comment on one line of the change, on the new side of the diff. */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

/** What the reviews leave for the human: the review's body and its comments on lines of the change. */
export interface ReviewNotes {
  body: string;
  comments: ReviewComment[];
}

/**
 * The review notes: minor findings and nits per lens, the blocking findings the verifier refuted
 * (with why), and any it confirmed that are still open because the run stopped for a human (a stall
 * or the review round cap). A finding whose file and line are in `inDiff` becomes a comment on that
 * line, starting with its lens and severity; the rest go in the body, grouped, with their place as
 * text. Without `inDiff` everything is in the body. Undefined when there is nothing to note.
 */
export function reviewNotes(reviews: LensReview[], verified?: ParsedVerdict<"verify">, inDiff?: DiffLines): ReviewNotes | undefined {
  const comments: ReviewComment[] = [];
  /** Comments on the finding's line when that line is in the diff; false when it goes in the body. */
  const inline = (f: Finding, text: string): boolean => {
    if (!f.file || !f.line) return false;
    const path = f.file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!inDiff?.get(path)?.has(f.line)) return false;
    comments.push({ path, line: f.line, body: text });
    return true;
  };
  const item = (f: Finding) => `- ${f.severity}: ${f.claim}${findingPlace(f)}`;
  const parts: string[] = [];
  let count = 0;
  const byId = new Map(blockingFindings(reviews).map((b) => [b.finding.id, b]));
  if (verified?.header.VERDICT === "CONFIRMED") {
    count += verified.findings.length;
    const rest = verified.findings.filter((f) => !inline(f, `**${byId.get(f.id)?.lens ?? "verifier"}** · ${f.severity} (confirmed by the verifier, not fixed): ${f.claim}`));
    if (rest.length) parts.push(["**Confirmed by the verifier, not fixed**", ...rest.map(item)].join("\n"));
  }
  for (const { lens, verdict } of reviews) {
    const minor = verdict.findings.filter((f) => !isBlocking(f));
    count += minor.length;
    const rest = minor.filter((f) => !inline(f, `**${lens}** · ${f.severity}: ${f.claim}`));
    if (rest.length) parts.push([`**${lens}**`, ...rest.map(item)].join("\n"));
  }
  if (verified) {
    const refuted = refutedFindings(verified.body, [...byId.keys()]);
    count += refuted.length;
    const rest = refuted.flatMap(({ id, reason }) => {
      const b = byId.get(id);
      if (!b) return [`- ${id}: ${reason}`];
      const { lens, finding } = b;
      if (inline(finding, `**${lens}** · ${finding.severity} (refuted by the verifier): ${finding.claim}\n\nRefuted: ${reason}`)) return [];
      return [`- ${lens} ${finding.severity}: ${finding.claim}${findingPlace(finding)}\n  Refuted: ${reason}`];
    });
    if (rest.length) parts.push(["**Refuted by the verifier**", ...rest].join("\n"));
  }
  if (!count) return undefined;
  const intro = `Review notes, left for you to judge.${comments.length ? " A note about a line of the change is on that line." : ""}`;
  return { body: [intro, ...parts].join("\n\n"), comments };
}
