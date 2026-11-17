import { isTerminal, type FactoryConfig } from "@factory/shared";
import type { GithubPort } from "../github/port.js";
import type { Project, Store } from "../store/store.js";
import { tickMetCriteria } from "./acceptance.js";
import { runDirOf } from "./shared.js";
import { closedIssueReason, RunMachine } from "./transitions.js";

/**
 * Finish the project's runs that GitHub has moved past. A run whose PR was merged ends done, closed
 * cancelled. A run whose issue was closed (done in another PR, a duplicate, not planned) is cancelled
 * when it has no open PR; with an open PR it stays for a human, who sees the closed issue on the run
 * (`waitingOn`) and whose cancel closes the PR too. A run another worker is driving is left for next
 * time. Returns one line per run that moved, and a warning instead of throwing
 * when GitHub cannot be asked (offline, not logged in).
 * A merged run's MET acceptance criteria are ticked on the issue (see tickMetCriteria).
 * `onMoved` is told each run it finished, e.g. to clean it up.
 */
export function reconcileWithGithub(store: Store, project: Project, github: GithubPort, config: FactoryConfig, onMoved?: (runId: string) => void): string[] {
  const machine = new RunMachine(store, config);
  const now = new Date().toISOString();
  const runs = store
    .listRuns({ project_id: project.id })
    .filter((r) => !isTerminal(r.state) && (r.pr_number !== null || r.issue_number !== null) && !(r.lease_expires_at !== null && r.lease_expires_at > now));
  const lines: string[] = [];
  for (const run of runs) {
    let openPr = false;
    if (run.pr_number !== null) {
      let pr;
      try {
        pr = github.pullRequestState(run.pr_number);
      } catch (err) {
        lines.push(`warning: could not check PR #${run.pr_number} of ${run.id}: ${(err as Error).message}`);
        continue;
      }
      if (pr.state === "open") {
        openPr = true;
      } else {
        try {
          const moved = machine.closeByPullRequest(run.id, pr);
          lines.push(`${run.id}: PR #${pr.number} ${pr.state} -> ${moved.state}`);
          // Merged: tick the criteria the acceptance lens found MET. A closed PR ticks nothing.
          if (pr.state === "merged" && run.issue_number !== null) {
            lines.push(...tickMetCriteria(github, runDirOf(project.repo_path, run.id), run.issue_number).map((note) => `${run.id}: ${note}`));
          }
          onMoved?.(run.id);
        } catch (err) {
          // E.g. a worker took the run in the meantime; it is checked again next time.
          lines.push(`warning: could not finish ${run.id}: ${(err as Error).message}`);
        }
        continue;
      }
    }
    if (run.issue_number === null) continue;
    const stored = store.getIssue(project.id, run.issue_number)?.state;
    // Already flagged for a human; cancelRun asks GitHub again before it closes the PR. Saves a gh call per parked run.
    if (openPr && stored === "closed") continue;

    let issue;
    try {
      issue = github.issueState(run.issue_number);
    } catch (err) {
      lines.push(`warning: could not check issue #${run.issue_number} of ${run.id}: ${(err as Error).message}`);
      continue;
    }
    if (issue.state === "open") {
      // Reopened on GitHub since a sync or a reconcile recorded it closed.
      if (stored === "closed") store.reopenIssue(project.id, issue.number);
      continue;
    }
    // A sync only lists open issues; record this one closed so the backlog and the inbox agree.
    store.closeIssue(project.id, issue.number);
    // Closing a PR is the human's call: the run shows its issue closed (waitingOn) until then.
    if (openPr) continue;
    try {
      // Only runs without a PR get here, so `closedBy` never names the factory's own.
      const moved = machine.closeByIssue(run.id, issue);
      lines.push(`${run.id}: ${closedIssueReason(issue)} -> ${moved.state}`);
      onMoved?.(run.id);
    } catch (err) {
      lines.push(`warning: could not finish ${run.id}: ${(err as Error).message}`);
    }
  }
  return lines;
}
