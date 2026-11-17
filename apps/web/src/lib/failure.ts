import type { RunState } from "@factory/shared";
import type { FailureItem, RunChecks, WaitingFailure } from "./api";

/** What sending a run to each stage does, in one line. */
export const TARGET_HELP: Partial<Record<RunState, string>> = {
  intake: "starts over: triage, the spec and the build run again",
  triage: "triage runs again, then the spec and the build",
  refine: "refine gets your message and rewrites the spec; the critic, build, checks and reviews run again",
  critic: "the spec critic judges the spec again, then the build runs",
  build: "the builder gets your message, then checks and reviews run again",
  gate: "the quality gate runs the checks again on the same commit, then the reviews",
  review: "the reviews run again on the same commit",
  capture: "the screenshots are taken again",
  pr: "the pull request is opened or updated again",
  merge: "the merge stage checks everything again on the same commit, then merges or asks you",
  learn: "the learner looks at the run again",
  rejected: "ends the run as rejected",
  cancelled: "ends the run as cancelled",
};

/** Targets that run triage again, and so cost more than any other way back. */
export const COSTLY_TARGETS: readonly RunState[] = ["intake", "triage"];

const HEADINGS: Record<WaitingFailure["kind"], string> = {
  checks: "Fix the required checks that failed on the pull request",
  quality_gate: "Fix what failed the quality gate",
  findings: "Fix the findings the verifier confirmed",
};

function where(item: { file?: string; line?: number }): string {
  return item.file ? ` at ${item.file}${item.line ? `:${item.line}` : ""}` : "";
}

function line(item: FailureItem): string {
  return `- ${item.name}${item.summary ? `: ${item.summary}` : ""}${where(item)}${item.link ? ` (${item.link})` : ""}`;
}

/**
 * The builder's instructions for a failure, for a person to edit before sending. A failed check of
 * code scanning lists its open alerts when they are known, e.g.
 * "- CodeQL: Missing rate limiting at apps/server/src/drafts.ts:296 (https://...)".
 */
export function failureMessage(failure: WaitingFailure, checks?: RunChecks): string {
  const lines = failure.items.flatMap((item) => {
    const alerts = failure.kind === "checks" ? (checks?.failed.find((c) => c.name === item.name)?.alerts ?? []) : [];
    if (alerts.length === 0) return [line(item)];
    return alerts.map((a) => line({ name: item.name, summary: `${a.description} (${a.rule})`, file: a.file, line: a.line, link: a.url }));
  });
  const heading = `${HEADINGS[failure.kind]}${failure.source ? ` (see ${failure.source} in the run folder)` : ""}:`;
  return [heading, ...lines].join("\n");
}

/** Only web links: what GitHub or an agent wrote must never become a `javascript:` link. */
export function webLink(url: string | undefined): string | undefined {
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}
