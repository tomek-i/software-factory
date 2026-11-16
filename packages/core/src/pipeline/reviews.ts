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
