import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBlocking, type CriterionAnswer, type CriterionStatus, type Finding } from "@factory/shared";
import type { GithubPort } from "../github/port.js";
import { quietMentions, REFINE_MARKER, specSectionRange, withoutSpecSection } from "./shared.js";

/**
 * The acceptance lens: the engine (not the agent) reads the checkbox criteria of the issue and of the
 * accepted refine spec, numbers them, and after the merge ticks the ones the lens found MET.
 */

/** One criterion as the engine numbered it. `text` is what follows the checkbox, as posted on GitHub. */
export interface Criterion {
  id: string;
  /** The issue body, or the refine spec (posted in the factory's refine comment). */
  source: "issue" | "spec";
  text: string;
}

/** A criterion and the lens's answer; NOT_CHECKED when the lens gave none. */
export interface CriterionResult extends Criterion {
  status: CriterionStatus | "NOT_CHECKED";
  evidence?: string;
}

/** What the engine records in `round-N/acceptance.json`. */
export interface AcceptanceRecord {
  criteria: CriterionResult[];
}

const CRITERIA_HEADING = /^ {0,3}(#{2,4})[ \t]*acceptance criteria[ \t]*:?[ \t]*#*[ \t]*$/i;
const HEADING = /^ {0,3}(#{1,6})[ \t]/;
const FENCE = /^ {0,3}(```|~~~)/;
/** `- [ ] text` or `* [x] text`; group 1 ends just before the box's mark. */
const CHECKBOX = /^([ \t]*[-*][ \t]+\[)([ xX])\][ \t]+(.*?)[ \t]*$/;

/**
 * The checkbox lines under every "Acceptance criteria" heading (`##` to `####`, any case, a trailing
 * colon allowed) up to the next heading of the same or a higher level. Fenced code is skipped, so an
 * example in a code block is not a criterion. `index` is the line's index in `text.split("\n")`.
 */
export function criterionLines(text: string): { index: number; checked: boolean; text: string }[] {
  const lines = text.split("\n");
  const out: { index: number; checked: boolean; text: string }[] = [];
  let level = 0;
  let fenced = false;
  lines.forEach((raw, index) => {
    const line = raw.replace(/\r$/, "");
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const criteria = CRITERIA_HEADING.exec(line);
    if (criteria) {
      level = criteria[1]!.length;
      return;
    }
    const heading = HEADING.exec(line);
    if (heading && heading[1]!.length <= level) level = 0;
    if (!level) return;
    const box = CHECKBOX.exec(line);
    if (box && box[3]) out.push({ index, checked: box[2] !== " ", text: box[3] });
  });
  return out;
}

/**
 * The run's criteria, numbered AC-1, AC-2, ...: the issue's first, then the refine spec's. A spec
 * criterion's text is the one the factory posted (mentions quoted), so ticking finds it in the comment.
 */
export function extractCriteria(issueBody: string, specBody?: string): Criterion[] {
  // On the factory's own issues refine keeps the spec in the body too; while that spec is current it
  // counts once, as the spec. After a later triage there is no current spec: the section is the issue's.
  const issue = criterionLines(specBody ? withoutSpecSection(issueBody) : issueBody).map((c) => ({ source: "issue" as const, text: c.text }));
  const spec = specBody ? criterionLines(specBody).map((c) => ({ source: "spec" as const, text: quietMentions(c.text) })) : [];
  return [...issue, ...spec].map((c, i) => ({ id: `AC-${i + 1}`, ...c }));
}

/** The lens's answers matched to the criteria: unknown ids are ignored, unanswered ones are NOT_CHECKED. */
export function matchAnswers(criteria: Criterion[], answers: CriterionAnswer[]): CriterionResult[] {
  const byId = new Map(answers.map((a) => [a.id.trim(), a]));
  return criteria.map((c) => {
    const answer = byId.get(c.id);
    if (!answer) return { ...c, status: "NOT_CHECKED" };
    const evidence = answer.evidence?.trim();
    return { ...c, status: answer.status, ...(evidence ? { evidence } : {}) };
  });
}

/** Criteria a human has to check: the ones the lens could not check, or did not answer. */
export const forHuman = (c: CriterionResult) => c.status === "CANNOT_CHECK" || c.status === "NOT_CHECKED";

/** E.g. "8/8 met, 1 for you to check", or "no criteria". */
export function acceptanceCount(criteria: CriterionResult[]): string {
  if (criteria.length === 0) return "no criteria";
  const met = criteria.filter((c) => c.status === "MET").length;
  const human = criteria.filter(forHuman).length;
  return `${met}/${criteria.length - human} met${human ? `, ${human} for you to check` : ""}`;
}

/** Each NOT_MET criterion as a major finding, so the verifier, the loop back and the stall check treat it like any other. */
export function acceptanceFindings(criteria: CriterionResult[]): Finding[] {
  return criteria
    .filter((c) => c.status === "NOT_MET")
    .map((c) => ({ id: `acceptance-${c.id}`, severity: "major" as const, claim: `${c.id} is not met: ${c.text}`, evidence: c.evidence ?? "not met" }));
}

/**
 * The acceptance lens's result as a review file (`review-acceptance.md`), so every reader of a round's
 * reviews (the review gate, the verifier, the PR notes, the approver, the learner) handles it unchanged.
 */
export function acceptanceReviewText(criteria: CriterionResult[], reported: Finding[] = []): string {
  const own = acceptanceFindings(criteria);
  // The lens's own findings (e.g. text that tried to steer it) come along, never under an engine id.
  const findings = [...own, ...reported.filter((f) => !own.some((o) => o.id === f.id))];
  return [
    `VERDICT: ${findings.some(isBlocking) ? "CHANGES" : "PASS"}`,
    "",
    "## Summary",
    `- Acceptance criteria: ${acceptanceCount(criteria)}`,
    "",
    "## Findings",
    "```json",
    JSON.stringify(findings, null, 2),
    "```",
    "",
  ].join("\n");
}

export function acceptanceRecordPath(roundDir: string): string {
  return join(roundDir, "acceptance.json");
}

export function writeAcceptanceRecord(roundDir: string, criteria: CriterionResult[]): void {
  writeFileSync(acceptanceRecordPath(roundDir), `${JSON.stringify({ criteria } satisfies AcceptanceRecord, null, 2)}\n`);
}

const STATUSES = new Set(["MET", "NOT_MET", "CANNOT_CHECK", "NOT_CHECKED"]);

/** A round's acceptance record, if it exists and has the expected shape. */
export function readAcceptanceRecord(roundDir: string): AcceptanceRecord | undefined {
  const path = acceptanceRecordPath(roundDir);
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { criteria?: unknown };
    if (!Array.isArray(data.criteria)) return undefined;
    const ok = data.criteria.every(
      (c: Partial<CriterionResult>) =>
        typeof c.id === "string" && (c.source === "issue" || c.source === "spec") && typeof c.text === "string" && STATUSES.has(c.status as string),
    );
    return ok ? (data as AcceptanceRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** The acceptance record of the latest round that has one. */
export function latestAcceptanceRecord(runDir: string): { round: number; record: AcceptanceRecord } | undefined {
  if (!existsSync(runDir)) return undefined;
  const rounds = readdirSync(runDir)
    .flatMap((entry) => {
      const n = Number(/^round-(\d+)$/.exec(entry)?.[1] ?? 0);
      return n ? [n] : [];
    })
    .sort((a, b) => b - a);
  for (const round of rounds) {
    const record = readAcceptanceRecord(join(runDir, `round-${round}`));
    if (record) return { round, record };
  }
  return undefined;
}

const STATUS_WORDS: Record<CriterionResult["status"], string> = {
  MET: "met",
  NOT_MET: "not met",
  CANNOT_CHECK: "for you to check",
  NOT_CHECKED: "not checked, for you to check",
};

/** The PR description's checklist; undefined when the run has no criteria. Mentions are quoted. */
export function acceptanceChecklist(record: AcceptanceRecord | undefined): string | undefined {
  if (!record?.criteria.length) return undefined;
  const items = record.criteria.map((c) => {
    const status = `${STATUS_WORDS[c.status]}${c.evidence ? `: ${oneLine(c.evidence)}` : ""}`;
    return `- [${c.status === "MET" ? "x" : " "}] ${c.id}: ${oneLine(c.text)}\n  ${status}`;
  });
  return quietMentions(`## Acceptance criteria\n${acceptanceCount(record.criteria)}.\n\n${items.join("\n")}`);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The merge gate's reasons for the criteria a human has to check. */
export function acceptanceReasons(record: AcceptanceRecord | undefined): string[] {
  const human = record?.criteria.filter(forHuman) ?? [];
  return human.length ? [`acceptance criteria for you to check: ${human.map((c) => `${c.id} ${oneLine(c.text)}`).join("; ")}`] : [];
}

/**
 * Tick `[ ]` -> `[x]` on the criterion lines of `text` whose text is in `wanted`, each line at most
 * once and in order (so two criteria with the same text tick two lines). Nothing else changes, line
 * endings included. A wanted line not found (e.g. a human edited it) is left alone and reported.
 */
export function tickCriteria(text: string, wanted: string[]): { text: string; ticked: number; missing: string[] } {
  const lines = text.split("\n");
  const candidates = criterionLines(text);
  const used = new Set<number>();
  const missing: string[] = [];
  let ticked = 0;
  for (const want of wanted) {
    const hit = candidates.find((c) => !used.has(c.index) && c.text === want.trim());
    if (!hit) {
      missing.push(want);
      continue;
    }
    used.add(hit.index);
    if (hit.checked) continue;
    const line = lines[hit.index]!;
    const prefix = CHECKBOX.exec(line.replace(/\r$/, ""))![1]!;
    lines[hit.index] = `${prefix}x${line.slice(prefix.length + 1)}`;
    ticked++;
  }
  return { text: lines.join("\n"), ticked, missing };
}

/**
 * After the run's PR merged: tick the MET criteria of its latest review round on GitHub, in the issue
 * body (only when the factory's account wrote the issue) and in the factory's refine comment. Never
 * throws: it returns what it did and warnings, since the merge already happened.
 */
export function tickMetCriteria(github: GithubPort, runDir: string, issueNumber: number): string[] {
  const latest = latestAcceptanceRecord(runDir);
  const met = latest?.record.criteria.filter((c) => c.status === "MET") ?? [];
  if (!met.length) return [];
  const notes: string[] = [];
  const tick = (where: string, source: Criterion["source"], read: () => string | undefined, write: (text: string) => void, absent: string) => {
    const wanted = met.filter((c) => c.source === source).map((c) => c.text);
    if (!wanted.length) return;
    try {
      const current = read();
      if (current === undefined) return void notes.push(absent);
      const result = tickCriteria(current, wanted);
      if (result.ticked) write(result.text);
      notes.push(`ticked ${result.ticked} acceptance criteri${result.ticked === 1 ? "on" : "a"} in ${where}`);
      if (result.missing.length) notes.push(`warning: ${result.missing.length} met criteri${result.missing.length === 1 ? "on was" : "a were"} not found in ${where} (edited since?); left as they are`);
    } catch (err) {
      notes.push(`warning: could not tick the acceptance criteria in ${where}: ${(err as Error).message}`);
    }
  };
  tick(
    `the body of issue #${issueNumber}`,
    "issue",
    () => github.ownIssueBody(issueNumber),
    (text) => github.editIssueBody(issueNumber, text),
    `not ticking the body of issue #${issueNumber}: the factory's account did not write it`,
  );
  if (!met.some((c) => c.source === "spec")) return notes;
  // The spec is in a section of the factory's own issue, or in the refine comment. The section wins:
  // an issue refined before the spec moved into the body may still have an old comment.
  let place: { body: string; range: { start: number; end: number } } | { comment: number } | undefined;
  try {
    const body = github.ownIssueBody(issueNumber);
    const range = body === undefined ? undefined : specSectionRange(body);
    if (body !== undefined && range) place = { body, range };
    else {
      const comment = github.findComment(issueNumber, REFINE_MARKER);
      if (comment !== undefined) place = { comment };
    }
  } catch (err) {
    notes.push(`warning: could not find the refine spec on issue #${issueNumber}: ${(err as Error).message}`);
    return notes;
  }
  if (!place) {
    notes.push(`warning: no refine comment or spec section was found on issue #${issueNumber}; its spec criteria stay unticked`);
  } else if ("comment" in place) {
    const { comment } = place;
    tick("the refine comment", "spec", () => github.commentBody(comment), (text) => github.editComment(comment, text), "");
  } else {
    const { body, range } = place;
    tick(
      `the spec section of issue #${issueNumber}`,
      "spec",
      () => body.slice(range.start, range.end),
      (text) => github.editIssueBody(issueNumber, body.slice(0, range.start) + text + body.slice(range.end)),
      "",
    );
  }
  return notes;
}
