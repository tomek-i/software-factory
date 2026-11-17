import { join } from "node:path";
import { feedbackDataOf, feedbackFile, oneLine } from "../pipeline/feedback.js";
import { bullets, readValid, runDirOf, section } from "../pipeline/shared.js";
import type { Project, Run, RunEvent, Store } from "../store/store.js";

/** One thing that failed, with what is known about where. */
export interface FailureItem {
  /** A check's name, or a finding's id. */
  name: string;
  summary?: string;
  link?: string;
  file?: string;
  line?: number;
}

/**
 * Something concrete a run waits on, which a human may hand to the builder: failed required checks
 * on the PR, a failed quality gate, blocking findings the verifier confirmed, or the PR's open
 * feedback (unresolved review threads and failed optional checks; their text is from GitHub).
 */
export interface WaitingFailure {
  kind: "checks" | "quality_gate" | "findings" | "feedback";
  items: FailureItem[];
  /** The run file it comes from, relative to the run folder; none for checks on GitHub. */
  source?: string;
}

/** What a run waiting for a human is stuck on. */
export interface Waiting {
  /** Set when a loop cap stopped it, e.g. "review round cap reached (3)": resumed as is, it stops again at once. */
  capReached?: string;
  failure?: WaitingFailure;
  /**
   * Its issue was closed on GitHub while its PR is still open (see reconcileWithGithub), so the work
   * was likely done elsewhere; cancelling it closes `pr` too.
   */
  issueClosed?: { pr: number };
}

/** The move that parked the run for a human: the last one into needs_human. */
export function parkingEvent(events: RunEvent[]): RunEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.to_state === "needs_human" && event.from_state !== "needs_human") return event;
  }
  return undefined;
}

/** What a run waiting for a human is stuck on; nothing for a run that is not waiting. */
export function waitingOn(store: Store, project: Project, run: Run): Waiting {
  if (run.state !== "needs_human") return {};
  const issueClosed =
    run.pr_number !== null && run.issue_number !== null && store.getIssue(project.id, run.issue_number)?.state === "closed" ? { issueClosed: { pr: run.pr_number } } : {};
  const parked = parkingEvent(store.listEvents(run.id));
  if (!parked) return issueClosed;
  // The loops' guards word every cap the same way (capProblem in transitions.ts).
  const cap = /[a-z][a-z ]* cap reached \(\d+\)/.exec(parked.reason)?.[0];
  const failure = failureOf(runDirOf(project.repo_path, run.id), run, parked);
  return { ...(cap ? { capReached: cap } : {}), ...(failure ? { failure } : {}), ...issueClosed };
}

function failureOf(dir: string, run: Run, parked: RunEvent): WaitingFailure | undefined {
  const data = parked.data as { failedChecks?: unknown } | null;
  if (parked.from_state === "merge" && Array.isArray(data?.failedChecks)) {
    const items = data.failedChecks.flatMap((c: { name?: unknown; link?: unknown }) =>
      typeof c?.name === "string" ? [{ name: c.name, ...(typeof c.link === "string" ? { link: c.link } : {}) }] : [],
    );
    if (items.length) return { kind: "checks", items };
  }
  const feedback = parked.from_state === "merge" ? feedbackDataOf(data) : undefined;
  if (feedback) {
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    // Written from GitHub by anyone and shown in a terminal too: one line each, no control characters.
    const items: FailureItem[] = [
      ...feedback.threads.flatMap((t) =>
        str(t?.author) && str(t?.url)
          ? [
              {
                name: `review thread by ${oneLine(t.author, 60)}`,
                ...(str(t.excerpt) ? { summary: oneLine(t.excerpt) } : {}),
                ...(str(t.path) ? { file: oneLine(t.path!, 200) } : {}),
                ...(typeof t.line === "number" ? { line: t.line } : {}),
                link: t.url,
              },
            ]
          : [],
      ),
      ...feedback.checks.flatMap((c) =>
        str(c?.name)
          ? [
              {
                name: oneLine(c.name, 100),
                summary: `${c.bucket === "cancel" ? "cancelled" : "failed"}${str(c.summary) ? `: ${oneLine(c.summary!)}` : ""}`,
                ...(str(c.link) ? { link: c.link } : {}),
              },
            ]
          : [],
      ),
    ];
    if (items.length) return { kind: "feedback", items, source: feedbackFile(run.round) };
  }
  // The gate stage's checks, or the merge stage's re-run of them after merging the default branch.
  const checks = parked.from_state === "gate" ? `round-${run.round}/checks.md` : parked.from_state === "merge" ? `round-${run.round}/resync/checks.md` : undefined;
  if (checks) {
    const verdict = readValid("checks", join(dir, checks), (v) => (v.header.GATE === "FAIL" ? [] : ["passed"]));
    if (verdict) return { kind: "quality_gate", items: failedChecksOf(verdict.body), source: checks };
  }
  if (parked.from_state === "review") {
    const verify = `round-${run.round}/verify.md`;
    const verdict = readValid("verify", join(dir, verify), (v) => (v.header.VERDICT === "CONFIRMED" ? [] : ["none confirmed"]));
    if (verdict) {
      const items = verdict.findings.map((f) => ({
        name: `${f.id} (${f.severity})`,
        summary: f.claim,
        ...(f.file ? { file: f.file } : {}),
        ...(f.line ? { line: f.line } : {}),
      }));
      return { kind: "findings", items, source: verify };
    }
  }
  return undefined;
}

/** The failed lines of a checks.md summary, e.g. "- lint: FAILED (exit 1) in 2.0s". */
function failedChecksOf(body: string): FailureItem[] {
  return bullets(section(body, "summary")).flatMap((line) => {
    if (!/FAILED|TIMED OUT|possible secret/.test(line)) return [];
    const colon = line.indexOf(": ");
    return [colon > 0 ? { name: line.slice(0, colon), summary: line.slice(colon + 2) } : { name: line }];
  });
}
