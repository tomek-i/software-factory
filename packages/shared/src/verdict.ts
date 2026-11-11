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

const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );

const sha = z.string().regex(/^[0-9a-f]{40}$/, "must be a full 40-character commit sha");

/** Header contract per output kind. Enum-like values are upper-cased before validation. */
export const verdictHeaderSchemas = {
  triage: z.object({
    DECISION: z.enum(["APPROVE", "REJECT", "NEEDS_INFO"]),
    READINESS: z.enum(["READY", "INCOMPLETE"]),
    RISK: z.enum(["LOW", "MEDIUM", "HIGH"]),
    SURFACES: csv,
  }),
  critic: z.object({ VERDICT: z.enum(["ACCEPT", "REVISE", "REJECT"]) }),
  // COMMIT ties the builder's report to the code it describes, so a stale READY can't be reused.
  build: z.object({ STATUS: z.enum(["READY", "BLOCKED"]), COMMIT: sha }),
  checks: z.object({ GATE: z.enum(["PASS", "FAIL"]), COMMIT: sha }),
  review: z.object({ VERDICT: z.enum(["PASS", "CHANGES"]) }),
  verify: z.object({ VERDICT: z.enum(["CONFIRMED", "NONE_CONFIRMED"]) }),
  approver: z.object({ DECISION: z.enum(["PROCEED", "ESCALATE"]) }),
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
const VERBATIM_KEYS = new Set(["COMMIT", "SURFACES"]);

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
