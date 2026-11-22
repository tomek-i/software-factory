import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseVerdict, REVIEW_LENSES, type FactoryConfig, type ParsedVerdict, type ReviewLens, type RunState, type VerdictKind } from "@factory/shared";
import type { GitEvidence } from "../git/worktrees.js";
import type { Run, RunEvent } from "../store/store.js";
import type { Evidence } from "./transitions.js";

/** Helpers the driver and its stages share. They need no driver: only the run folder and plain values. */

export const RUNS_DIR = join(".factory", "runs");
export const DEFAULT_PORT_BASE = 4700;

/**
 * Where approving a waiting gate sends the run. Triage goes where an approving triage would have sent
 * it: `afterTriage`, which callers that can read the run folder get from nextAfterTriage. Approving
 * the critic gate accepts the spec as it is and moves on to build. Approving the review gate moves
 * on to capture; a run parked there before reviews were automated (parked from the quality gate)
 * gets its reviews instead. Approving the PR gate moves on to merge (which marks the PR ready
 * itself), and approving the merge gate lets the merge stage merge the commit that was waiting.
 */
export function approveTarget(run: Pick<Run, "waiting_gate" | "parked_from">, afterTriage: RunState): RunState | undefined {
  switch (run.waiting_gate) {
    case "triage":
      return afterTriage;
    case "critic":
      return "build";
    case "review":
      return run.parked_from === "gate" ? "review" : "capture";
    case "pr":
    case "merge":
      return "merge";
    default:
      return undefined;
  }
}

/**
 * Where an approved issue goes after triage: an INCOMPLETE one to refine, a READY one to the spec
 * critic, or straight to build when the critic gate is set to always (no critic would run).
 */
export function nextAfterTriage(runDir: string, config: Pick<FactoryConfig, "gates">): "refine" | "critic" | "build" {
  const triage = readValid("triage", join(runDir, "triage.md"), () => []);
  if (triage?.header.READINESS === "INCOMPLETE") return "refine";
  return config.gates.critic === "always" ? "build" : "critic";
}

/**
 * Hidden marker of the refined spec on the issue, one per issue, edited in place on later rounds: the
 * start of its comment, or of its section in the body of an issue the factory's account wrote.
 */
export const REFINE_MARKER = "<!-- factory:refine -->";
/** Where that section in the issue body ends. */
export const REFINE_END_MARKER = "<!-- /factory:refine -->";

/**
 * The issue body with `section` (which starts with REFINE_MARKER and ends with REFINE_END_MARKER) in
 * place of the one already there, or added at the end. Only a start marker followed by an end marker
 * counts, so a stray marker never cuts the author's text. The section takes the body's line endings:
 * bodies written in GitHub's editor use CRLF.
 */
export function withSpecSection(body: string, section: string): string {
  const text = /\r\n/.test(body) ? section.replace(/\r?\n/g, "\r\n") : section;
  const range = specSectionRange(body);
  if (range) return body.slice(0, range.start) + text + body.slice(range.end);
  const before = body.trimEnd();
  return before ? `${before}${/\r\n/.test(body) ? "\r\n\r\n" : "\n\n"}${text}` : text;
}

/** Where the spec section is in an issue body, markers included: a start marker followed by an end marker. */
export function specSectionRange(body: string): { start: number; end: number } | undefined {
  const start = body.indexOf(REFINE_MARKER);
  const end = start === -1 ? -1 : body.indexOf(REFINE_END_MARKER, start);
  return end === -1 ? undefined : { start, end: end + REFINE_END_MARKER.length };
}

/** Agent text without the refine markers, so a spec quoting them cannot end its own section early. */
export function withoutMarkers(text: string): string {
  return text.replaceAll(REFINE_END_MARKER, "").replaceAll(REFINE_MARKER, "");
}

/** The issue body as its author wrote it: without the factory's spec section. */
export function withoutSpecSection(body: string): string {
  const range = specSectionRange(body);
  return range ? body.slice(0, range.start) + body.slice(range.end) : body;
}

/**
 * Spec rounds live in `spec-N/`: refine.md (when refine ran) and the critic.md that judged it. The
 * number only grows, so a later round never overwrites an earlier one's files. Returns the highest N
 * whose folder has `file` (either file when not given), or 0.
 */
export function latestSpecRound(runDir: string, file?: "refine.md" | "critic.md"): number {
  if (!existsSync(runDir)) return 0;
  let latest = 0;
  for (const entry of readdirSync(runDir)) {
    const n = Number(/^spec-(\d+)$/.exec(entry)?.[1] ?? 0);
    const has = (name: string) => existsSync(join(runDir, entry, name));
    if (n > latest && (file ? has(file) : has("refine.md") || has("critic.md"))) latest = n;
  }
  return latest;
}

/** The round a critic turn judges: the one refine just wrote, or a new one when there is none to judge. */
export function criticRound(runDir: string): number {
  const latest = latestSpecRound(runDir);
  return latest > 0 && !existsSync(join(runDir, `spec-${latest}`, "critic.md")) ? latest : latest + 1;
}

export function specFile(runDir: string, round: number, file: "refine.md" | "critic.md"): string {
  return join(runDir, `spec-${round}`, file);
}

/** The highest spec round below `before` for which `read` gives a value, with that value. */
export function latestRoundWith<T>(before: number, read: (round: number) => T | undefined): { round: number; value: T } | undefined {
  for (let round = before - 1; round >= 1; round--) {
    const value = read(round);
    if (value !== undefined) return { round, value };
  }
  return undefined;
}

/** readValid check: a refine output that is a spec (a BLOCKED one has none). */
export const refined = (v: ParsedVerdict<"refine">) => (v.header.STATUS === "REFINED" ? [] : ["refine was blocked"]);

/**
 * Agent text the factory posts on an issue, with every `@name` in backticks so GitHub does not notify
 * those people: an agent repeating (or being steered into) a mention must not ping anyone.
 */
export function quietMentions(text: string): string {
  return text.replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9_.-]+)?)(?![\w`])/g, "$1`@$2`");
}

/** The commit a run waiting at the merge gate is waiting on, recorded on the event that parked it. */
export function waitingCommit(events: RunEvent[]): string | undefined {
  const data = events.at(-1)?.data as { commit?: unknown } | null | undefined;
  return typeof data?.commit === "string" ? data.commit : undefined;
}

/** A lens's review file in a round folder. */
export function reviewPath(roundDir: string, lens: ReviewLens): string {
  return join(roundDir, `review-${lens}.md`);
}

/** A lens's review in a round folder, if it exists and is valid. */
export function readReview(roundDir: string, lens: ReviewLens): ParsedVerdict<"review"> | undefined {
  const path = reviewPath(roundDir, lens);
  if (!existsSync(path)) return undefined;
  try {
    return parseVerdict("review", readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A verdict file, if it exists, parses, and passes `validate`. */
export function readValid<K extends VerdictKind>(kind: K, path: string, validate: (verdict: ParsedVerdict<K>) => string[]): ParsedVerdict<K> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const verdict = parseVerdict(kind, readFileSync(path, "utf8"));
    return validate(verdict).length === 0 ? verdict : undefined;
  } catch {
    return undefined;
  }
}

/** One line of run history for an agent: long reasons are cut so one cannot crowd out the rest. */
export function clip(text: string, max = 500): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

/** Where an approved triage gate led: refine, the spec critic or build all count as its approval. */
export function afterTriage(to: RunState): RunState {
  return to === "refine" || to === "critic" ? to : "build";
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function runDirOf(root: string, runId: string): string {
  return join(root, RUNS_DIR, runId);
}

/** Wait `ms`, or less when `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Output file of each verdict kind, relative to the run folder. Per-round files live in round-N/;
 * refine's and the critic's live in spec-N/, read from the latest spec round that has one.
 */
export function verdictPath(runDir: string, kind: VerdictKind, round: number): string {
  switch (kind) {
    case "refine":
    case "critic":
      return specFile(runDir, latestSpecRound(runDir, `${kind}.md`) || 1, `${kind}.md`);
    case "checks":
    case "verify":
    case "capture":
    case "acceptance":
      return join(runDir, `round-${round}`, `${kind}.md`);
    case "approver":
      return join(runDir, "approval.md");
    case "threads":
      return join(runDir, `round-${round}`, "resync", "threads.md");
    default:
      return join(runDir, `${kind}.md`);
  }
}

export const noGit: GitEvidence = {
  head: () => {
    throw new Error("the run has no worktree yet");
  },
  isClean: () => {
    throw new Error("the run has no worktree yet");
  },
  commitsAhead: () => {
    throw new Error("the run has no worktree yet");
  },
  isPushed: () => {
    throw new Error("the run has no worktree yet");
  },
};

/** Evidence read from the run folder and worktree, for the state machine's guards. */
export function runEvidence(runDir: string, round: number, git: GitEvidence = noGit): Evidence {
  return {
    verdict: <K extends VerdictKind>(kind: K): ParsedVerdict<K> => {
      const path = verdictPath(runDir, kind, round);
      if (!existsSync(path)) throw new Error(`${relative(runDir, path)} does not exist`);
      return parseVerdict(kind, readFileSync(path, "utf8"));
    },
    // Every lens that wrote a review this round; which lenses had to run is the review stage's business.
    reviews: () => REVIEW_LENSES.flatMap((lens) => readReview(join(runDir, `round-${round}`), lens) ?? []),
    specRound: (file) => latestSpecRound(runDir, file),
    git,
  };
}

/** The `- ` bullets of a section's text. */
export function bullets(text: string | undefined): string[] {
  return (text ?? "").split(/\r?\n/).flatMap((line) => /^[-*]\s+(.+)$/.exec(line.trim())?.[1] ?? []);
}

/** The text under a "## <name>" heading of an agent's output, if present. */
export function section(body: string, name: string): string | undefined {
  const match = new RegExp(`^#{2,3}\\s*${name}\\s*:?\\s*$([\\s\\S]*?)(?=^#{1,3}\\s|$(?![\\s\\S]))`, "im").exec(body);
  return match?.[1]?.trim() || undefined;
}

/** A Summary bullet longer than this is worth a note: it becomes a hard-to-scan line in the PR. */
export const LONG_SUMMARY_BULLET = 200;

/** How many of the hand-over's Summary bullets are longer than {@link LONG_SUMMARY_BULLET}. */
export function longSummaryBullets(buildBody: string): number {
  return bullets(section(buildBody, "summary")).filter((b) => b.length > LONG_SUMMARY_BULLET).length;
}

/**
 * The draft PR description from the builder's hand-over: a short brief for the human reviewer first,
 * with the implementation notes (useful to reviewing agents, noisy for people) collapsed below it.
 * `checklist` is the acceptance criteria checklist, `screenshots` the capture stage's `## Screenshots`
 * section. The reviews' notes are a review on the PR, not part of the description.
 */
export function prBody(buildBody: string, issueNumber: number, unsafe = false, checklist?: string, screenshots?: string): string {
  const parts: string[] = [];
  if (unsafe) {
    parts.push("> [!WARNING]\n> Built with `--unsafe`: hard rules (protected paths, new dependencies, secret files, deletions) were lifted for this run.");
  }
  const summary = section(buildBody, "summary");
  const testing = section(buildBody, "testing");
  const details = section(buildBody, "details");
  if (summary) parts.push(`## What\n${summary}`);
  if (testing) parts.push(`## How it was tested\n${testing}`);
  if (screenshots) parts.push(screenshots.trim());
  // Blank lines around the content so GitHub renders the markdown inside <details>.
  if (details) parts.push(`<details><summary>Implementation details</summary>\n\n${details}\n\n</details>`);
  if (checklist) parts.push(checklist.trim());
  parts.push(`Closes #${issueNumber}`);
  return `${parts.join("\n\n")}\n`;
}
