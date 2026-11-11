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

const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean),
  );

/** Header contract per output kind. Values are validated after upper-casing enum-like fields. */
export const verdictHeaderSchemas = {
  triage: z.object({
    DECISION: z.enum(["APPROVE", "REJECT", "NEEDS_INFO"]),
    READINESS: z.enum(["READY", "INCOMPLETE"]),
    RISK: z.enum(["LOW", "MEDIUM", "HIGH"]),
    SURFACES: csv,
  }),
  critic: z.object({ VERDICT: z.enum(["ACCEPT", "REVISE", "REJECT"]) }),
  build: z.object({ STATUS: z.enum(["READY", "BLOCKED"]) }),
  checks: z.object({ GATE: z.enum(["PASS", "FAIL"]), COMMIT: z.string().regex(/^[0-9a-f]{40}$/) }),
  review: z.object({ VERDICT: z.enum(["PASS", "CHANGES"]) }),
  verify: z.object({ VERDICT: z.enum(["CONFIRMED", "NONE_CONFIRMED"]) }),
  approver: z.object({ DECISION: z.enum(["PROCEED", "ESCALATE"]) }),
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

function parseHeaderLines(lines: string[]): { raw: Record<string, string>; rest: number } {
  const raw: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const match = HEADER_LINE.exec(lines[i]!.trim());
    if (!match) break;
    raw[match[1]!] = match[2]!.trim();
  }
  return { raw, rest: i };
}

function sectionLines(lines: string[], heading: string): string[] | undefined {
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`);
  if (start === -1) return undefined;
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) break;
    out.push(lines[i]!);
  }
  return out;
}

function parseFindings(lines: string[]): { findings: Finding[]; problems: string[] } {
  const section = sectionLines(lines, "findings");
  if (!section) return { findings: [], problems: [] };
  const text = section.join("\n");
  const block = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!block) {
    return text.trim() === "" || /^none\.?$/i.test(text.trim())
      ? { findings: [], problems: [] }
      : { findings: [], problems: ["## Findings must contain a ```json array block"] };
  }
  let data: unknown;
  try {
    data = JSON.parse(block[1]!);
  } catch (err) {
    return { findings: [], problems: [`findings JSON is invalid: ${(err as Error).message}`] };
  }
  const result = z.array(findingSchema).safeParse(data);
  if (!result.success) {
    return { findings: [], problems: result.error.issues.map((i) => `findings.${i.path.join(".")}: ${i.message}`) };
  }
  return { findings: result.data, problems: [] };
}

/** Parse and validate an agent output file. Throws VerdictParseError listing every problem found. */
export function parseVerdict<K extends VerdictKind>(kind: K, text: string): ParsedVerdict<K> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const { raw, rest } = parseHeaderLines(lines);
  const problems: string[] = [];

  if (Object.keys(raw).length === 0) problems.push("file must start with KEY: VALUE header lines");

  const schema = verdictHeaderSchemas[kind];
  const normalised: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // Enum-like values are matched case-insensitively; COMMIT stays as written (hex is lower-case).
    normalised[key] = key === "COMMIT" || key === "SURFACES" ? value : value.toUpperCase();
  }
  const header = schema.safeParse(normalised);
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
