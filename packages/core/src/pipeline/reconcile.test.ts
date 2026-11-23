import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema, type RunState } from "@factory/shared";
import type { GithubPort, IssueState, PullRequestState } from "../github/port.js";
import { Store, type StatePatch } from "../store/store.js";
import { tempDir } from "../../test/helpers.js";
import { writeAcceptanceRecord } from "./acceptance.js";
import { reconcileWithGithub } from "./reconcile.js";
import { runDirOf } from "./shared.js";

const MERGE = "c".repeat(40);

/** Issues not listed in `issues` are open. */
function setup(prs: Record<number, Omit<PullRequestState, "number"> | Error>, repoPath = "/repo", issues: Record<number, Omit<IssueState, "number"> | Error> = {}) {
  const store = new Store(":memory:");
  const config = factoryConfigSchema.parse({ version: 1 });
  const project = store.upsertProject({ name: "demo", repo_path: repoPath, github_repo: "o/r" });
  const issueEdits: { number: number; body: string }[] = [];
  const asked: number[] = [];
  const askedIssues: number[] = [];
  const github: GithubPort = {
    commentOnIssue: () => undefined,
    findComment: () => undefined,
    editComment: () => undefined,
    commentBody: () => "",
    ownIssueBody: () => "## Acceptance criteria\n- [ ] done\n",
    editIssueBody: (number, body) => issueEdits.push({ number, body }),
    findPullRequest: () => undefined,
    createDraftPullRequest: () => 1,
    createPullRequest: () => 1,
    findOpenPullRequests: () => [],
    updatePullRequest: () => undefined,
    markReady: () => undefined,
    mergePullRequest: () => undefined,
    requiredChecks: () => [],
    pullRequestChecks: () => [],
    pullRequestDiff: () => ({ head: "h", additions: 0, deletions: 0, changedFiles: 0 }),
    unresolvedReviewThreads: () => [],
    replyToReviewThread: () => undefined,
    resolveReviewThread: () => undefined,
    createIssue: () => {
      throw new Error("no issues here");
    },
    codeScanningAlerts: () => [],
    dismissCodeScanningAlert: () => undefined,
    hasReview: () => false,
    createReview: () => undefined,
    pullRequestState: (number) => {
      asked.push(number);
      const pr = prs[number];
      if (!pr) throw new Error(`unexpected PR #${number}`);
      if (pr instanceof Error) throw pr;
      return { number, ...pr };
    },
    issueState: (number) => {
      askedIssues.push(number);
      const issue = issues[number] ?? { state: "open", closedBy: [] };
      if (issue instanceof Error) throw issue;
      return { number, ...issue };
    },
    closePullRequest: () => {
      throw new Error("reconcile closed a PR: only a human's cancel may");
    },
  };
  const make = (issue: number, state: RunState, patch: StatePatch = {}) => {
    const run = store.createRun({ project_id: project.id, title: "t", issue_number: issue });
    store.writeState(run.id, state, patch);
    return run.id;
  };
  return { store, config, project, github, asked, askedIssues, make, issueEdits, reconcile: () => reconcileWithGithub(store, project, github, config) };
}

describe("reconcileWithGithub", () => {
  it("finishes merged and closed PRs and leaves open ones and runs without a PR alone", () => {
    const { store, make, reconcile, asked } = setup({
      1: { state: "merged", draft: false, head: "h", mergeCommit: MERGE },
      2: { state: "closed", draft: true, head: "h" },
      3: { state: "open", draft: true, head: "h" },
    });
    const merged = make(1, "needs_human", { pr_number: 1, waiting_gate: "review" });
    const closed = make(2, "review", { pr_number: 2 });
    const open = make(3, "needs_human", { pr_number: 3, waiting_gate: "review" });
    const noPr = make(4, "needs_human");
    const finished = make(5, "done", { pr_number: 5 });

    expect(reconcile().sort()).toEqual([`${merged}: PR #1 merged -> done`, `${closed}: PR #2 closed -> cancelled`]);
    expect([merged, closed, open, noPr, finished].map((id) => store.getRun(id)!.state)).toEqual(["done", "cancelled", "needs_human", "needs_human", "done"]);
    expect(asked.sort()).toEqual([1, 2, 3]);
    // Nothing changed the second time, so nothing is printed.
    expect(reconcile()).toEqual([]);
  });

  it("tells the caller which runs it finished, and only those", () => {
    const { store, project, github, config, make } = setup({ 1: { state: "merged", draft: false, head: "h", mergeCommit: MERGE } });
    const merged = make(1, "needs_human", { pr_number: 1 });
    // Finished by its worker, not by reconcile.
    make(2, "cancelled");
    const moved: string[] = [];
    reconcileWithGithub(store, project, github, config, (id) => moved.push(id));
    expect(moved).toEqual([merged]);
  });

  it("warns instead of failing when GitHub cannot be asked, and checks the other runs", () => {
    const { store, make, reconcile } = setup({
      1: new Error("gh: not logged in"),
      2: { state: "merged", draft: false, head: "h", mergeCommit: MERGE },
    });
    const broken = make(1, "needs_human", { pr_number: 1 });
    const merged = make(2, "needs_human", { pr_number: 2 });
    expect(reconcile().sort()).toEqual([`${merged}: PR #2 merged -> done`, `warning: could not check PR #1 of ${broken}: gh: not logged in`]);
    expect(store.getRun(broken)!.state).toBe("needs_human");
  });

  it("ticks the MET acceptance criteria of a merged run, and none of a closed one", () => {
    const root = tempDir();
    const { make, reconcile, issueEdits } = setup(
      { 1: { state: "merged", draft: false, head: "h", mergeCommit: MERGE }, 2: { state: "closed", draft: false, head: "h" } },
      root,
    );
    const merged = make(1, "needs_human", { pr_number: 1 });
    const closed = make(2, "needs_human", { pr_number: 2 });
    for (const id of [merged, closed]) {
      const roundDir = join(runDirOf(root, id), "round-1");
      mkdirSync(roundDir, { recursive: true });
      writeAcceptanceRecord(roundDir, [{ id: "AC-1", source: "issue", text: "done", status: "MET", evidence: "a.ts:1" }]);
    }

    expect(reconcile()).toContain(`${merged}: ticked 1 acceptance criterion in the body of issue #1`);
    expect(issueEdits).toEqual([{ number: 1, body: "## Acceptance criteria\n- [x] done\n" }]);
  });

  it("skips a run another worker is driving", () => {
    const { store, make, reconcile, asked } = setup({ 1: { state: "merged", draft: false, head: "h", mergeCommit: MERGE } });
    const driven = make(1, "merge", { pr_number: 1 });
    store.acquireLease(driven, "worker-1", 60_000);
    expect(reconcile()).toEqual([]);
    expect(asked).toEqual([]);
    expect(store.getRun(driven)!.state).toBe("merge");
  });

  describe("closed issues", () => {
    const CLOSED: Omit<IssueState, "number"> = { state: "closed", reason: "completed", closedBy: [221] };

    it("cancels a run without a PR whose issue was closed, and marks the issue closed", () => {
      const { store, project, github, config, make, reconcile } = setup({}, "/repo", { 4: CLOSED });
      store.upsertIssue(project.id, { number: 4, title: "t", body: "", state: "open", author: "a", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
      store.setQueued(project.id, 4, true);
      const parked = make(4, "needs_human", { waiting_gate: "triage" });
      const moved: string[] = [];

      expect(reconcileWithGithub(store, project, github, config, (id) => moved.push(id))).toEqual([
        `${parked}: issue #4 was closed on GitHub (completed, by #221) -> cancelled`,
      ]);
      expect(moved).toEqual([parked]);
      expect(store.getRun(parked)!.state).toBe("cancelled");
      expect(store.getIssue(project.id, 4)).toMatchObject({ state: "closed", queued_at: null });
      expect(store.listDecisions(parked).at(-1)).toMatchObject({ gate: "triage", outcome: "reject", comment: "issue #4 was closed on GitHub (completed, by #221)" });
      expect(reconcile()).toEqual([]);
    });

    it("leaves a run with an open PR for a human, records the issue closed, and asks GitHub only once", () => {
      const { store, project, make, reconcile, askedIssues } = setup({ 3: { state: "open", draft: false, head: "h" } }, "/repo", {
        4: { state: "closed", reason: "duplicate", closedBy: [3] },
      });
      store.upsertIssue(project.id, { number: 4, title: "t", body: "", state: "open", author: "a", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
      const waiting = make(4, "needs_human", { pr_number: 3, waiting_gate: "merge" });

      expect(reconcile()).toEqual([]);
      expect(store.getRun(waiting)!.state).toBe("needs_human");
      expect(store.getIssue(project.id, 4)!.state).toBe("closed");
      // Already known closed: the human decides, and cancelRun asks GitHub again before closing the PR.
      expect(reconcile()).toEqual([]);
      expect(askedIssues).toEqual([4]);
    });

    it("records an issue reopened on GitHub as open again, and leaves its run alone", () => {
      const issues: Record<number, Omit<IssueState, "number">> = {};
      const { store, project, make, reconcile } = setup({}, "/repo", issues);
      store.upsertIssue(project.id, { number: 4, title: "t", body: "", state: "open", author: "a", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
      store.closeIssue(project.id, 4);
      const parked = make(4, "needs_human", { waiting_gate: "triage" });

      expect(reconcile()).toEqual([]);
      expect(store.getIssue(project.id, 4)).toMatchObject({ state: "open", queued_at: null });
      expect(store.getRun(parked)!.state).toBe("needs_human");
    });

    it("finishes by the PR first when it was merged or closed, without asking about the issue", () => {
      const { make, reconcile, askedIssues } = setup({ 1: { state: "closed", draft: false, head: "h" } }, "/repo", { 1: CLOSED });
      const closed = make(1, "needs_human", { pr_number: 1 });
      expect(reconcile()).toEqual([`${closed}: PR #1 closed -> cancelled`]);
      expect(askedIssues).toEqual([]);
    });

    it("leaves runs with an open issue, warns when GitHub cannot be asked, and skips a driven run", () => {
      const { store, make, reconcile, askedIssues } = setup({}, "/repo", { 5: new Error("gh: not logged in"), 6: CLOSED });
      const open = make(4, "needs_human");
      const broken = make(5, "build");
      const driven = make(6, "build");
      store.acquireLease(driven, "worker-1", 60_000);

      expect(reconcile()).toEqual([`warning: could not check issue #5 of ${broken}: gh: not logged in`]);
      expect([open, broken, driven].map((id) => store.getRun(id)!.state)).toEqual(["needs_human", "build", "build"]);
      expect(askedIssues.sort()).toEqual([4, 5]);
    });
  });
});
