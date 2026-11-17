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
    const item = bulletItem(line);
    if (!item) return [];
    for (const id of ids) {
      const match = new RegExp(`^\`?${escapeRegExp(id)}\`?\\s*:\\s*(.+)$`).exec(item);
      if (match) return [{ id, reason: match[1]!.trim() }];
    }
    const refuted = splitRefuted(item);
    return refuted ? [refuted] : [];
  });
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);
/** Text with no line terminator in it (what `.` matches). */
const ONE_LINE = /^.*$/;

/**
 * The text of a top-level bullet (`- text` or `* text`), or undefined. String handling rather than a
 * regex, so a long line cannot make it backtrack.
 */
function bulletItem(line: string): string | undefined {
  if (line[0] !== "-" && line[0] !== "*") return undefined;
  let start = 1;
  while (isSpace(line[start])) start++;
  if (start === 1) return undefined;
  const item = line.slice(start);
  return item && ONE_LINE.test(item) ? item : undefined;
}

/**
 * `id: why` with an id that is not a known one: the id is the shortest text before a `:` that is
 * followed by whitespace and a reason, without backticks around it. Linear time: `next[i]` is the
 * first non-whitespace position at or after i.
 */
function splitRefuted(item: string): { id: string; reason: string } | undefined {
  const n = item.length;
  const next = new Array<number>(n + 1);
  next[n] = n;
  for (let i = n - 1; i >= 0; i--) next[i] = isSpace(item[i]) ? next[i + 1]! : i;
  const from = (start: number) => {
    for (let end = start + 1; end < n; end++) {
      const colon = next[item[end] === "`" ? end + 1 : end]!;
      if (item[colon] !== ":") continue;
      // At least one whitespace character after the colon, then a reason (which may be whitespace).
      const reasonAt = next[colon + 1]!;
      const spaces = reasonAt - colon - 1;
      if (spaces >= 1 && (reasonAt < n || spaces >= 2)) return { id: item.slice(start, end), reason: item.slice(colon + 1).trim() };
    }
    return undefined;
  };
  return (item[0] === "`" ? from(1) : undefined) ?? from(0);
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

/**
 * The PR description's review notes: minor findings and nits per lens, the blocking findings the
 * verifier refuted (with why), and any it confirmed that are still open because the run stopped for
 * a human (a stall or the review round cap). Undefined when there is nothing to note.
 */
export function reviewNotes(reviews: LensReview[], verified?: ParsedVerdict<"verify">): string | undefined {
  const parts: string[] = [];
  if (verified?.header.VERDICT === "CONFIRMED") {
    parts.push(`**Confirmed by the verifier, not fixed**\n${verified.findings.map((f) => `- ${f.severity}: ${f.claim}${findingPlace(f)}`).join("\n")}`);
  }
  for (const { lens, verdict } of reviews) {
    const minor = verdict.findings.filter((f) => !isBlocking(f));
    if (minor.length) parts.push(`**${lens}**\n${minor.map((f) => `- ${f.severity}: ${f.claim}${findingPlace(f)}`).join("\n")}`);
  }
  if (verified) {
    const byId = new Map(blockingFindings(reviews).map((b) => [b.finding.id, b]));
    const refuted = refutedFindings(verified.body, [...byId.keys()]).map(({ id, reason }) => {
      const b = byId.get(id);
      return b ? `- ${b.lens} ${b.finding.severity}: ${b.finding.claim}${findingPlace(b.finding)}\n  Refuted: ${reason}` : `- ${id}: ${reason}`;
    });
    if (refuted.length) parts.push(`**Refuted by the verifier**\n${refuted.join("\n")}`);
  }
  return parts.length ? `## Review notes\nLeft for you to judge.\n\n${parts.join("\n\n")}` : undefined;
}
