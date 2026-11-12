import { parseVerdict, VerdictParseError } from "@factory/shared";

/**
 * The issue writer's draft: the usual header (`DECISION: PROCEED | ESCALATE`) and summary, then the
 * issues, each opened by a delimiter line and its own header lines:
 *
 *   === ISSUE ===          <- the single issue, or the parent of the sub-issues
 *   TITLE: ...
 *   UI: YES | NO
 *   RISK: LOW | MEDIUM | HIGH
 *
 *   ## Why / ## What / ## Acceptance criteria / ## Scope / ## Out of scope
 *
 *   === SUB-ISSUE ===      <- none, or two or more
 *   ...
 *   DEPENDS_ON: 1, 2       <- optional: earlier sub-issues by position
 *
 * The operator may edit the file before approving it, so it is parsed again, just as strictly,
 * before anything is created.
 */

export const ISSUE_DELIMITER = "=== ISSUE ===";
export const SUB_ISSUE_DELIMITER = "=== SUB-ISSUE ===";
export const REQUIRED_SECTIONS = ["Why", "What", "Acceptance criteria", "Scope", "Out of scope"] as const;
/** More than this is a project plan, not an issue; it would also flood the repository. */
export const MAX_SUB_ISSUES = 10;

const RISKS = ["LOW", "MEDIUM", "HIGH"] as const;
const HEADER_LINE = /^([A-Z][A-Z_]*):\s*(.*)$/;

export interface DraftIssue {
  title: string;
  ui: boolean;
  risk: (typeof RISKS)[number];
  /** Sub-issues only: positions (1-based) of earlier sub-issues this one needs first. */
  dependsOn: number[];
  /** The issue's sections, as written. */
  body: string;
}

export interface IssueDraft {
  decision: "PROCEED" | "ESCALATE";
  summary: string[];
  /** Why the agent escalated. */
  reasons: string[];
  /** The single issue, or the parent of `subIssues`. */
  issue: DraftIssue;
  subIssues: DraftIssue[];
}

function bullets(lines: string[], heading: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s*${heading}\\s*:?\\s*$`, "i").test(l.trim()));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line)) break;
    const match = /^[-*]\s+(.+)$/.exec(line.trim());
    if (match) out.push(match[1]!);
  }
  return out;
}

/** One issue block (the lines after its delimiter). Problems are prefixed with the block's name. */
function parseBlock(lines: string[], name: string, sub: boolean, position: number): { issue?: DraftIssue; problems: string[] } {
  const problems: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  const raw: Record<string, string> = {};
  for (; i < lines.length; i++) {
    const match = HEADER_LINE.exec(lines[i]!.trim());
    if (!match) break;
    const key = match[1]!;
    if (key in raw) problems.push(`${name}: header ${key} appears more than once`);
    raw[key] = match[2]!.trim();
  }
  const allowed = sub ? ["TITLE", "UI", "RISK", "DEPENDS_ON"] : ["TITLE", "UI", "RISK"];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) problems.push(`${name}: unknown header ${key} (allowed: ${allowed.join(", ")})`);
  }

  const title = raw.TITLE ?? "";
  if (!title) problems.push(`${name}: TITLE is missing`);
  else if (title.length > 200) problems.push(`${name}: TITLE is longer than 200 characters`);
  const ui = raw.UI?.toUpperCase();
  if (ui !== "YES" && ui !== "NO") problems.push(`${name}: UI must be YES or NO`);
  const risk = raw.RISK?.toUpperCase();
  if (!RISKS.includes(risk as (typeof RISKS)[number])) problems.push(`${name}: RISK must be LOW, MEDIUM or HIGH`);

  const dependsOn: number[] = [];
  for (const part of (sub ? (raw.DEPENDS_ON ?? "") : "").split(",").map((p) => p.trim().replace(/^#/, "")).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n >= position) {
      problems.push(`${name}: DEPENDS_ON ${part} is not an earlier sub-issue (1 to ${position - 1})`);
    } else if (!dependsOn.includes(n)) dependsOn.push(n);
  }

  const body = lines.slice(i).join("\n").trim();
  const headings = [...body.matchAll(/^##\s+(.+?)\s*:?\s*$/gm)].map((m) => m[1]!.toLowerCase());
  for (const section of REQUIRED_SECTIONS) {
    const count = headings.filter((h) => h === section.toLowerCase()).length;
    if (count === 0) problems.push(`${name}: section ## ${section} is missing`);
    if (count > 1) problems.push(`${name}: section ## ${section} appears more than once`);
  }
  const criteria = /^##\s+Acceptance criteria\s*:?\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(body)?.[1] ?? "";
  if (headings.includes("acceptance criteria") && !/^\s*[-*]\s+\[[ xX]\]\s+\S/m.test(criteria)) {
    problems.push(`${name}: ## Acceptance criteria needs at least one "- [ ]" checkbox`);
  }

  if (problems.length) return { problems };
  return { issue: { title, ui: ui === "YES", risk: risk as DraftIssue["risk"], dependsOn, body }, problems };
}

/** The issues of a draft body (everything after the header lines), or the problems found. */
export function parseIssueBlocks(body: string): { issue?: DraftIssue; subIssues: DraftIssue[]; problems: string[] } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const starts = lines.flatMap((line, index) => {
    const text = line.trim().toUpperCase();
    return text === ISSUE_DELIMITER ? [{ index, sub: false }] : text === SUB_ISSUE_DELIMITER ? [{ index, sub: true }] : [];
  });
  const problems: string[] = [];
  const parents = starts.filter((s) => !s.sub);
  if (parents.length !== 1) problems.push(`the draft needs exactly one "${ISSUE_DELIMITER}" line (found ${parents.length})`);
  if (starts[0]?.sub) problems.push(`"${SUB_ISSUE_DELIMITER}" blocks must come after the "${ISSUE_DELIMITER}" block`);
  const subCount = starts.filter((s) => s.sub).length;
  if (subCount === 1) problems.push("a parent issue needs at least two sub-issues; write a single issue instead");
  if (subCount > MAX_SUB_ISSUES) problems.push(`at most ${MAX_SUB_ISSUES} sub-issues (found ${subCount})`);
  if (problems.length) return { subIssues: [], problems };

  let issue: DraftIssue | undefined;
  const subIssues: DraftIssue[] = [];
  starts.forEach((start, k) => {
    const block = lines.slice(start.index + 1, starts[k + 1]?.index ?? lines.length);
    const name = start.sub ? `sub-issue ${k}` : "issue";
    const parsed = parseBlock(block, name, start.sub, k);
    problems.push(...parsed.problems);
    if (!parsed.issue) return;
    if (start.sub) subIssues.push(parsed.issue);
    else issue = parsed.issue;
  });
  return problems.length ? { subIssues: [], problems } : { issue, subIssues, problems };
}

/** Parse and validate a whole draft file. Throws VerdictParseError listing every problem found. */
export function parseDraft(text: string): IssueDraft {
  const verdict = parseVerdict("issue_writer", text);
  const { issue, subIssues, problems } = parseIssueBlocks(verdict.body);
  if (!issue || problems.length) throw new VerdictParseError("invalid issue draft", problems);
  // The summary and reasons come before the first issue, so an issue's own lists never count.
  const preamble = verdict.body.split("\n");
  const first = preamble.findIndex((l) => l.trim().toUpperCase() === ISSUE_DELIMITER);
  const before = preamble.slice(0, first);
  return {
    decision: verdict.header.DECISION,
    summary: bullets(before, "summary"),
    reasons: bullets(before, "reasons"),
    issue,
    subIssues,
  };
}

/**
 * The body the issue gets on GitHub: its sections, then the UI flag, risk and any sub-issues it
 * needs first (by their GitHub numbers, known once those are created).
 */
export function issueBody(issue: DraftIssue, dependsOn: number[] = []): string {
  const facts = [`**UI change:** ${issue.ui ? "yes" : "no"}`, `**Risk:** ${issue.risk.toLowerCase()}`];
  if (dependsOn.length) facts.push(`**Depends on:** ${dependsOn.map((n) => `#${n}`).join(", ")}`);
  return `${issue.body}\n\n---\n\n${facts.join(" · ")}\n`;
}
