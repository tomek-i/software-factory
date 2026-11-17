import { latestReviews, runCost, type GithubPort, type ReviewSummary, type ProjectContext, type PullRequestCheck, type PullRequestDiff, type Run } from "@factory/core";

/** How long a PR's head and diff, and the checks of a head still running some, are reused. */
export const GITHUB_TTL_MS = 30_000;
/** Heads kept per cache; the oldest go first. Far more than one Inbox ever shows. */
const MAX_ENTRIES = 500;

/** The checks on a PR's head, counted the way the merge stage judges them: a cancelled check failed. */
export interface CheckSummary {
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  /** Named, with their link when GitHub gave one. Data from GitHub: the page links only http(s). */
  failedChecks: { name: string; link?: string }[];
}

/** What a merge decision needs to see: the PR, its checks, the reviews, rounds and cost. */
export interface MergeGateDetails {
  /** Null when the run has no PR. The diff fields are missing when GitHub could not be read. */
  pr: { number: number; url: string | null; head?: string; additions?: number; deletions?: number; changedFiles?: number } | null;
  /** Null when there is no PR or GitHub could not be read. */
  checks: CheckSummary | null;
  /** The latest gated round's review per lens. */
  reviews: ReviewSummary[];
  rounds: { build: number; review: number };
  cost: number;
  /** Why GitHub could not be read; the rest still holds. */
  githubError?: string;
}

export function summariseChecks(checks: PullRequestCheck[]): CheckSummary {
  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel");
  return {
    passed: checks.filter((c) => c.bucket === "pass").length,
    failed: failed.length,
    pending: checks.filter((c) => c.bucket === "pending").length,
    skipped: checks.filter((c) => c.bucket === "skipping").length,
    failedChecks: failed.map((c) => ({ name: c.name, ...(c.link ? { link: c.link } : {}) })),
  };
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

/**
 * Reads merge-gate details, keeping GitHub's answers so re-renders don't ask again: a PR's head and
 * diff for a short while, a head's checks for good once none is pending (they no longer change).
 */
export class MergeGateReader {
  private readonly diffs = new Map<string, { at: number; diff: PullRequestDiff }>();
  private readonly checks = new Map<string, { at: number; checks: PullRequestCheck[] }>();

  constructor(private readonly clock: () => number = Date.now) {}

  details(key: string, ctx: ProjectContext, run: Run, github: () => GithubPort | undefined, redact: (text: string) => string): MergeGateDetails {
    const repo = ctx.project.github_repo;
    const reviews = latestReviews(ctx.store, ctx.project, run.id).map((r) => ("problem" in r ? { ...r, problem: redact(r.problem) } : r));
    const base = { reviews, rounds: { build: run.build_iterations + 1, review: run.review_rounds + 1 }, cost: runCost(ctx.store, run.id) };
    const number = run.pr_number;
    if (number === null) return { ...base, pr: null, checks: null };
    const pr = { number, url: repo ? `https://github.com/${repo}/pull/${number}` : null };
    const port = repo ? github() : undefined;
    if (!port) return { ...base, pr, checks: null, githubError: "This project has no GitHub repository." };
    try {
      const diff = this.diff(`${key}#${number}`, () => port.pullRequestDiff(number));
      const checks = this.headChecks(`${key}#${number}@${diff.head}`, () => port.pullRequestChecks(number));
      return { ...base, pr: { ...pr, ...diff }, checks: summariseChecks(checks) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ...base, pr, checks: null, githubError: redact(message.split("\n")[0]!.slice(0, 300)) };
    }
  }

  private diff(key: string, read: () => PullRequestDiff): PullRequestDiff {
    const now = this.clock();
    const cached = this.diffs.get(key);
    if (cached && now - cached.at < GITHUB_TTL_MS) return cached.diff;
    const diff = read();
    remember(this.diffs, key, { at: now, diff });
    return diff;
  }

  private headChecks(key: string, read: () => PullRequestCheck[]): PullRequestCheck[] {
    const now = this.clock();
    const cached = this.checks.get(key);
    // An empty list may only mean "none started yet", so it is rechecked like a pending one.
    const settled = cached && cached.checks.length > 0 && !cached.checks.some((c) => c.bucket === "pending");
    if (cached && (settled || now - cached.at < GITHUB_TTL_MS)) return cached.checks;
    const checks = read();
    remember(this.checks, key, { at: now, checks });
    return checks;
  }
}
