import { z } from "zod";

/**
 * Every agent writes exactly one output file:
 *
 *   KEY: VALUE          <- machine-readable header lines, parsed by the engine
 *   KEY: VALUE
 *
 *   ## Summary          <- 3-5 bullets shown in the UI
 *   - ...
 *
 *   ## Findings         <- optional fenced json array (reviewers, verifier)
 *   ```json
 *   [...]
 *   ```
 *
 * The parser is deliberately strict: agent output can be influenced by untrusted text, so anything
 * ambiguous (duplicate keys, several findings blocks, a verdict that contradicts its findings) is
 * rejected rather than resolved.
 */

export const SEVERITIES = ["critical", "major", "minor", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const findingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(SEVERITIES),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  claim: z.string().min(1),
  evidence: z.string().min(1),
});
export type Finding = z.infer<typeof findingSchema>;

export const isBlocking = (f: Finding) => f.severity === "critical" || f.severity === "major";

/**
 * A lesson the learner proposes from one run. `rule` is the single line that would go into
 * `.factory/lessons.md` once a human approves it, so it must stay one short line.
 */
export const lessonSchema = z.object({
  observation: z.string().min(1),
  evidence: z.string().min(1),
  rule: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((r) => !/[\r\n]/.test(r), { message: "must be a single line" })
    .refine((r) => !Array.from(r).some((ch) => isUnprintable(ch.codePointAt(0)!)), {
      message: "must not contain control, line-separator or text-direction characters",
    }),
});
export type Lesson = z.infer<typeof lessonSchema>;

/**
 * Code points that can hide or reorder text in a terminal or a rendered file: C0 and C1 controls
 * (including escape sequences), the line and paragraph separators, and the bidi marks, embeddings,
 * overrides and isolates. Numbers rather than a regex, so the ranges read the same everywhere.
 */
const UNPRINTABLE: [number, number][] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

export function isUnprintable(code: number): boolean {
  return UNPRINTABLE.some(([from, to]) => code >= from && code <= to);
}

const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character commit sha");

/**
 * A Conventional Commit subject line, as the repo's PR-title check enforces it: squash merges turn
 * the PR title into the commit on the default branch, and release tooling reads those commits.
 */
export const CONVENTIONAL_TITLE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\s]+\))?!?: [^A-Z\s].*$/;

/** Why a builder's TITLE cannot name a pull request, or undefined when it can. */
export function pullRequestTitleProblem(title: string | undefined): string | undefined {
  if (!title) return "TITLE is missing: the hand-over that opens the pull request names it, as type(scope): subject";
  if (title.length > 100) return "TITLE is longer than 100 characters";
  if (!CONVENTIONAL_TITLE.test(title)) return `TITLE "${title}" is not a Conventional Commit subject: type(scope): subject, starting lowercase`;
  return undefined;
}

/** Header contract per output kind. Enum-like values are upper-cased before validation. */
export const verdictHeaderSchemas = {
  triage: z.object({
    DECISION: z.enum(["APPROVE", "REJECT", "NEEDS_INFO"]),
    READINESS: z.enum(["READY", "INCOMPLETE"]),
    RISK: z.enum(["LOW", "MEDIUM", "HIGH"]),
    SURFACES: csv,
  }),
  // BLOCKED when no spec can be written from the issue and the code (e.g. its text tries to steer the agent).
  refine: z.object({ STATUS: z.enum(["REFINED", "BLOCKED"]) }),
  critic: z.object({ VERDICT: z.enum(["ACCEPT", "REVISE", "REJECT"]) }),
  // COMMIT ties the builder's report to the code it describes, so a stale READY can't be reused.
  // TITLE names the PR. Only the READY hand-over that opens it needs one, so the driver checks it
  // (pullRequestTitleProblem): a filler title on a BLOCKED hand-over must not fail the parse.
  build: z.object({ STATUS: z.enum(["READY", "BLOCKED"]), COMMIT: sha, TITLE: z.string().optional() }),
  checks: z.object({ GATE: z.enum(["PASS", "FAIL"]), COMMIT: sha }),
  review: z.object({ VERDICT: z.enum(["PASS", "CHANGES"]) }),
  verify: z.object({ VERDICT: z.enum(["CONFIRMED", "NONE_CONFIRMED"]) }),
  approver: z.object({ DECISION: z.enum(["PROCEED", "ESCALATE"]) }),
  // PLAN comes with a ## Plan json block (parseCapturePlan); SKIP when nothing visible can be shown.
  capture: z.object({ CAPTURE: z.enum(["PLAN", "SKIP"]) }),
  // How many lessons the `## Lessons` block proposes; zero is the common case.
  learn: z.object({ LESSONS: z.string().regex(/^\d+$/, "must be a whole number").transform(Number) }),
  // The issues themselves follow the header in delimited blocks (see drafts/draft.ts in core).
  issue_writer: z.object({ DECISION: z.enum(["PROCEED", "ESCALATE"]) }),
} as const;

export type VerdictKind = keyof typeof verdictHeaderSchemas;
export type VerdictHeader<K extends VerdictKind> = z.infer<(typeof verdictHeaderSchemas)[K]>;

export interface ParsedVerdict<K extends VerdictKind> {
  header: VerdictHeader<K>;
  summary: string[];
  findings: Finding[];
  body: string;
}

export class VerdictParseError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(`${message}: ${problems.join("; ")}`);
    this.name = "VerdictParseError";
  }
}

const HEADER_LINE = /^([A-Z][A-Z_]*):\s*(.*)$/;
const VERBATIM_KEYS = new Set(["COMMIT", "SURFACES", "TITLE"]);

function parseHeaderLines(lines: string[]): { raw: Record<string, string>; rest: number; problems: string[] } {
  const raw: Record<string, string> = {};
  const problems: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const match = HEADER_LINE.exec(lines[i]!.trim());
    if (!match) break;
    const key = match[1]!;
    if (key in raw) problems.push(`header ${key} appears more than once`);
    raw[key] = match[2]!.trim();
  }
  return { raw, rest: i, problems };
}

/** Lines under a "## <name>" or "### <name>" heading (tolerating a trailing colon), up to the next heading. */
function sectionLines(lines: string[], name: string): string[] | undefined {
  const heading = new RegExp(`^#{2,3}\\s*${name}\\s*:?\\s*$`, "i");
  const start = lines.findIndex((l) => heading.test(l.trim()));
  if (start === -1) return undefined;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3}\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out;
}

function parseFindings(lines: string[]): { findings: Finding[]; problems: string[] } {
  const section = sectionLines(lines, "findings");
  if (!section) return { findings: [], problems: [] };
  const text = section.join("\n");
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length === 0) {
    return text.trim() === "" || /^none\.?$/i.test(text.trim())
      ? { findings: [], problems: [] }
      : { findings: [], problems: ["## Findings must contain a ```json array block"] };
  }
  if (blocks.length > 1) return { findings: [], problems: ["## Findings must contain exactly one ```json block"] };

  let data: unknown;
  try {
    data = JSON.parse(blocks[0]![1]!);
  } catch (err) {
    return { findings: [], problems: [`findings JSON is invalid: ${(err as Error).message}`] };
  }
  const result = z.array(findingSchema).safeParse(data);
  if (!result.success) {
    return { findings: [], problems: result.error.issues.map((i) => `findings.${i.path.join(".")}: ${i.message}`) };
  }
  const ids = result.data.map((f) => f.id);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  return {
    findings: result.data,
    problems: duplicates.length ? [`duplicate finding ids: ${duplicates.join(", ")}`] : [],
  };
}

/**
 * The learner's `## Lessons` section: one ```json array of lessons, or nothing / "None." for none.
 * Same strictness as the findings block.
 */
function parseLessonLines(lines: string[]): { lessons: Lesson[]; problems: string[] } {
  const section = sectionLines(lines, "lessons");
  if (!section) return { lessons: [], problems: [] };
  const text = section.join("\n");
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length === 0) {
    return text.trim() === "" || /^none\.?$/i.test(text.trim())
      ? { lessons: [], problems: [] }
      : { lessons: [], problems: ["## Lessons must contain a ```json array block"] };
  }
  if (blocks.length > 1) return { lessons: [], problems: ["## Lessons must contain exactly one ```json block"] };
  let data: unknown;
  try {
    data = JSON.parse(blocks[0]![1]!);
  } catch (err) {
    return { lessons: [], problems: [`lessons JSON is invalid: ${(err as Error).message}`] };
  }
  const result = z.array(lessonSchema).safeParse(data);
  if (!result.success) {
    return { lessons: [], problems: result.error.issues.map((i) => `lessons.${i.path.join(".")}: ${i.message}`) };
  }
  return { lessons: result.data, problems: [] };
}

/** The lessons of a learner's output body (ParsedVerdict.body). Throws VerdictParseError when malformed. */
export function parseLessons(body: string): Lesson[] {
  const { lessons, problems } = parseLessonLines(body.replace(/\r\n/g, "\n").split("\n"));
  if (problems.length) throw new VerdictParseError("invalid lessons", problems);
  return lessons;
}

/** A verdict must agree with its own findings. */
function consistencyProblems(kind: VerdictKind, header: Record<string, unknown>, findings: Finding[]): string[] {
  const blocking = findings.filter(isBlocking).length;
  if (kind === "review") {
    if (header.VERDICT === "PASS" && blocking) return ["VERDICT: PASS contradicts critical/major findings"];
    if (header.VERDICT === "CHANGES" && !blocking) return ["VERDICT: CHANGES needs at least one critical/major finding"];
  }
  if (kind === "verify") {
    if (header.VERDICT === "CONFIRMED" && !blocking) return ["VERDICT: CONFIRMED needs the confirmed findings listed"];
    if (header.VERDICT === "NONE_CONFIRMED" && blocking) return ["VERDICT: NONE_CONFIRMED contradicts listed findings"];
  }
  return [];
}

/** Parse and validate an agent output file. Throws VerdictParseError listing every problem found. */
export function parseVerdict<K extends VerdictKind>(kind: K, text: string): ParsedVerdict<K> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const { raw, rest, problems } = parseHeaderLines(lines);

  if (Object.keys(raw).length === 0) problems.push("file must start with KEY: VALUE header lines");

  const normalised: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    normalised[key] = VERBATIM_KEYS.has(key) ? value : value.toUpperCase();
  }
  const header = verdictHeaderSchemas[kind].safeParse(normalised);
  if (!header.success) {
    problems.push(...header.error.issues.map((i) => `header ${i.path.join(".")}: ${i.message}`));
  }

  const bodyLines = lines.slice(rest);
  const summary = (sectionLines(bodyLines, "summary") ?? [])
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ""));

  const { findings, problems: findingProblems } = parseFindings(bodyLines);
  problems.push(...findingProblems);
  if (header.success && findingProblems.length === 0) {
    problems.push(...consistencyProblems(kind, header.data as Record<string, unknown>, findings));
  }
  if (kind === "learn") {
    const { lessons, problems: lessonProblems } = parseLessonLines(bodyLines);
    problems.push(...lessonProblems);
    const count = header.success ? (header.data as { LESSONS: number }).LESSONS : undefined;
    if (count !== undefined && lessonProblems.length === 0 && count !== lessons.length) {
      problems.push(`LESSONS: ${count} but ## Lessons lists ${lessons.length}`);
    }
  }

  if (problems.length > 0 || !header.success) {
    throw new VerdictParseError(`invalid ${kind} output`, problems);
  }
  return {
    header: header.data as VerdictHeader<K>,
    summary,
    findings,
    body: bodyLines.join("\n").trim(),
  };
}
