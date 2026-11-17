/**
 * Shared setup for the PipelineDriver tests. They are split over several `driver*.int.test.ts` files so
 * Vitest runs them in parallel: each test drives real git and fake `claude` processes for seconds.
 */
import { Store } from "../src/store/store.js";
import { createAgentRunner } from "../src/agents/runner.js";
import type { CapturePort } from "../src/capture/capture.js";
import { loadTrustedConfig, trustedReader } from "../src/config/trusted.js";
import { FactoryEvents, type FactoryEvent } from "../src/events.js";
import type { CodeScanningAlert, DismissReason, GithubPort, MergeMethod, PullRequestCheck, PullRequestReview, RequiredCheck, ReviewThread } from "../src/github/port.js";
import { PipelineDriver } from "../src/pipeline/driver.js";
import { fakeClaude, git, repoWithRemote, REVIEW_PASS, type FakeStep } from "./helpers.js";

export const TRIAGE = (decision = "APPROVE", extra = "") =>
  `DECISION: ${decision}\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- looks fine\n${extra}`;
export const READY = "STATUS: READY\nCOMMIT: {{HEAD}}\nTITLE: feat: add the feature\n\n## Summary\n- done\n";

/** A builder round that writes feature.txt and commits it (the engine pushes), then reports READY. */
export const buildStep = (content: string, output = READY): FakeStep => ({
  files: { "feature.txt": `${content}\n` },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", `feat: ${content}`],
  ],
  output,
});

// Built by concatenation so this file contains no secret-shaped string.
export const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

/** A builder round that commits a change but leaves feature.txt broken, so the gate fails the same way. */
export const sameFailure = (attempt: number): FakeStep => ({
  files: { "feature.txt": "broken\n", "attempt.txt": `${attempt}\n` },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", `fix: attempt ${attempt}`],
  ],
  output: READY,
});

// The gate passes only once feature.txt says "fixed". A failure names the content, plus noise that
// changes every round (commit, timing, worktree path) and must not hide a repeated failure.
export const CHECK_JS = `const fs = require("fs");
const content = fs.existsSync("feature.txt") ? fs.readFileSync("feature.txt", "utf8").trim() : "(missing)";
const ok = content === "fixed";
if (!ok) {
  const head = require("child_process").execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  console.error("checked " + head + " in " + (Date.now() % 997) + "ms at " + process.cwd());
  console.error("feature.txt is not fixed yet: " + content);
}
process.exit(ok ? 0 : 1);
`;

/**
 * Most driver tests are about what happens after the spec is settled, so their configs pass the spec
 * critic gate straight through (`critic: always`) unless they set it themselves; with that, a READY
 * issue goes from triage to build as it did before the critic existed.
 */
export function passCritic(config: string): string {
  if (/^[ \t]+critic:/m.test(config)) return config;
  return /^gates:[ \t]*$/m.test(config) ? config.replace(/^gates:[ \t]*$/m, "gates:\n  critic: always") : `${config.trimEnd()}\ngates:\n  critic: always\n`;
}

export function setup(
  steps: FakeStep[],
  options: {
    author?: string;
    config?: string;
    capture?: CapturePort;
    /** More files on the default branch, e.g. a `CLAUDE.md`. */
    files?: Record<string, string>;
    /** The issue's body (synced and on the fake GitHub); "Please add feature.txt." by default. */
    issueBody?: string;
    /** Whether the factory's account wrote the issue, so it may edit its body. */
    ownIssue?: boolean;
  } = {},
) {
  const config = passCritic(
    options.config ??
      "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  review: human\n",
  );
  const { root, remote } = repoWithRemote({
    "README.md": "# demo\n",
    "check.js": CHECK_JS,
    ".gitignore": ".factory/runs/\n.worktrees/\n",
    ".factory/config.yaml": config,
    ...options.files,
  });
  const fake = fakeClaude(steps);
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.upsertIssue(project.id, {
    number: 12,
    title: "Add the feature",
    body: options.issueBody ?? "Please add feature.txt.",
    state: "open",
    author: options.author ?? "alice",
    labels: [],
    url: "https://github.com/o/r/issues/12",
    gh_updated_at: "2026-01-01T00:00:00Z",
  });
  store.setQueued(project.id, 12, true);

  // Every comment the factory posted, with its current body; `id` is what findComment/editComment use.
  const comments: { issue: number; body: string; id: number; edits: number }[] = [];
  // The issue's body on the fake GitHub, and every edit the factory made to it.
  const issueBody = { text: options.issueBody ?? "Please add feature.txt.", own: options.ownIssue ?? false, edits: 0 };
  const prs: { head: string; base: string; title: string; body: string }[] = [];
  const readyPrs: { head: string; base: string; title: string; body: string }[] = [];
  const closedReady = new Set<number>();
  const edits: { number: number; body: string }[] = [];
  // Every review the factory left on a PR; `reviewErrors`: what the next posts throw, one each, in turn.
  const reviews: ({ number: number } & PullRequestReview)[] = [];
  const reviewErrors: string[] = [];
  // The run's PR as the fake GitHub sees it; a test may merge or close it, or make merging fail.
  // `checks`: what each look at the required checks returns, in turn; the last one repeats. None by default.
  const pr: {
    state: "open" | "merged" | "closed";
    draft: boolean;
    mergeCommit?: string;
    mergeError?: string;
    onView?: (count: number) => void;
    checks?: RequiredCheck[][];
    checksError?: string;
    /** The PR's head as GitHub reports it; by default what the run's branch has on the remote. */
    head?: string;
    /** Open code scanning alerts; a dismissed one leaves the list. */
    alerts?: CodeScanningAlert[];
    /** What the required checks become once no alert is left (GitHub updates the check in place). */
    checksWhenClear?: RequiredCheck[];
    /** Every check on the PR's head, required or not: what each look returns, in turn; the last one repeats. None by default. */
    allChecks?: PullRequestCheck[][];
    /** Open review threads (neither resolved nor outdated): what each look returns, in turn; the last one repeats. None by default. */
    threads?: ReviewThread[][];
  } = {
    state: "open",
    draft: true,
  };
  let views = 0;
  const merges: { number: number; head: string; method?: MergeMethod }[] = [];
  let checkViews = 0;
  let allCheckViews = 0;
  let threadViews = 0;
  const dismissals: { alert: number; reason: DismissReason; comment: string }[] = [];
  const github: GithubPort = {
    commentOnIssue: (issue, body) => comments.push({ issue, body, id: 100 + comments.length, edits: 0 }),
    findComment: (issue, marker) => comments.findLast((c) => c.issue === issue && c.body.startsWith(marker))?.id,
    editComment: (id, body) => {
      const comment = comments.find((c) => c.id === id);
      if (!comment) throw new Error(`no comment ${id}`);
      comment.body = body;
      comment.edits++;
    },
    commentBody: (id) => {
      const comment = comments.find((c) => c.id === id);
      if (!comment) throw new Error(`no comment ${id}`);
      return comment.body;
    },
    ownIssueBody: () => (issueBody.own ? issueBody.text : undefined),
    editIssueBody: (_number, body) => {
      if (!issueBody.own) throw new Error("the factory edited an issue it did not write");
      issueBody.text = body;
      issueBody.edits++;
    },
    findPullRequest: (branch) => (prs.some((p) => p.head === branch) ? 7 : undefined),
    createDraftPullRequest: (pr) => {
      prs.push(pr);
      return 7;
    },
    // Only the engine's lessons PR is opened ready for review.
    // Numbered 8, 9, ... and open until a test says otherwise (`closedReady`).
    createPullRequest: (pr) => {
      readyPrs.push(pr);
      return 7 + readyPrs.length;
    },
    findOpenPullRequests: (prefix) =>
      readyPrs.flatMap((p, i) => (p.head.startsWith(prefix) && !closedReady.has(8 + i) ? [{ number: 8 + i, head: p.head }] : [])),
    updatePullRequest: (number, body) => edits.push({ number, body }),
    hasReview: (number, marker) => reviews.some((r) => r.number === number && r.body.startsWith(marker)),
    createReview: (number, review) => {
      const error = reviewErrors.shift();
      if (error) throw new Error(error);
      reviews.push({ number, ...review });
    },
    pullRequestState: (number) => {
      pr.onView?.(++views);
      const head = pr.head ?? (prs[0] ? git(remote, "rev-parse", `refs/heads/${prs[0].head}`) : "");
      return { number, state: pr.state, draft: pr.draft, head, ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}) };
    },
    markReady: () => {
      pr.draft = false;
    },
    requiredChecks: () => {
      if (pr.checksError) throw new Error(pr.checksError);
      if (pr.checksWhenClear && pr.alerts?.length === 0) return pr.checksWhenClear;
      const all = pr.checks ?? [[]];
      return all[Math.min(checkViews++, all.length - 1)]!;
    },
    pullRequestChecks: () => {
      const all = pr.allChecks ?? [[]];
      return all[Math.min(allCheckViews++, all.length - 1)]!;
    },
    unresolvedReviewThreads: () => {
      const all = pr.threads ?? [[]];
      return all[Math.min(threadViews++, all.length - 1)]!;
    },
    codeScanningAlerts: () => [...(pr.alerts ?? [])],
    dismissCodeScanningAlert: (alert, reason, comment) => {
      dismissals.push({ alert, reason, comment });
      pr.alerts = pr.alerts?.filter((a) => a.number !== alert);
    },
    mergePullRequest: (number, head, method) => {
      if (pr.mergeError) throw new Error(pr.mergeError);
      if (pr.draft) throw new Error("a draft PR cannot be merged");
      merges.push({ number, head, ...(method && method !== "merge" ? { method } : {}) });
      pr.state = "merged";
      pr.mergeCommit = "e".repeat(40);
    },
  };
  const events = new FactoryEvents();
  const seen: FactoryEvent[] = [];
  events.on((e) => seen.push(e));

  const read = trustedReader(root, "main");
  const driver = new PipelineDriver({
    store,
    project,
    config: loadTrustedConfig(read, "main"),
    read,
    runAgent: createAgentRunner({ store, events, env: fake.env }),
    github,
    owner: "test-worker",
    events,
    watchMs: 50,
    checksPollMs: 20,
    checksGraceMs: 200,
    capture: options.capture,
  });
  return { root, remote, store, project, driver, fake, github, comments, issueBody, prs, readyPrs, closedReady, edits, reviews, reviewErrors, seen, pr, merges, dismissals };
}

/** Helpers of the `PipelineDriver > reviews` tests. */
export const reviewConfig = (reviews: string) =>
  `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  review: human\n${reviews}`;
const finding = (severity: string) =>
  `## Findings\n\`\`\`json\n[{ "id": "code-1", "severity": "${severity}", "file": "feature.txt", "line": 1, "claim": "it says fixed", "evidence": "line 1" }]\n\`\`\`\n`;
export const review = (verdict: string, severity?: string) => `VERDICT: ${verdict}\n\n## Summary\n- reviewed\n\n${severity ? finding(severity) : "## Findings\nNone.\n"}`;

/** Learn-stage tests: one review lens, and the merge gate as given (default: always, so the run merges by itself). */
export const learnConfig = (merge = "always") =>
  `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  merge: ${merge}\nreviews:\n  always: [code]\n  ui: []\n`;
export const CODE_PASS: FakeStep = { role: "reviewer-code", output: REVIEW_PASS };
export const LESSON = {
  observation: "The builder wrote `broken` first and the feature check failed.",
  evidence: "round-1/checks.md (feature failed), round-2/checks.md (passed)",
  rule: "Run `node check.js` before handing over; the gate only passes when feature.txt says fixed.",
};
export const learned = (lessons: object[]) =>
  `LESSONS: ${lessons.length}\n\n## Summary\n- the gate failed once\n\n## Lessons\n\`\`\`json\n${JSON.stringify(lessons, null, 2)}\n\`\`\`\n`;
/** A run whose first build fails the quality gate, so it takes two rounds before it merges. */
export const bumpy = (...learner: FakeStep[]): FakeStep[] => [{ output: TRIAGE() }, buildStep("broken"), buildStep("fixed"), CODE_PASS, ...learner.map((s) => ({ role: "learner", ...s }))];

export const lastMove = (store: Store, runId: string) => store.listEvents(runId).at(-1)!;
