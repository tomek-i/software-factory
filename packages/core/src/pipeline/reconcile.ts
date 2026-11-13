import { isTerminal, type FactoryConfig } from "@factory/shared";
import type { GithubPort } from "../github/port.js";
import type { Project, Store } from "../store/store.js";
import { RunMachine } from "./transitions.js";

/**
 * Finish the project's runs whose PR was merged or closed on GitHub: merged -> done, closed ->
 * cancelled. A run another worker is driving is left for next time. Returns one line per run that
 * moved, and a warning instead of throwing when GitHub cannot be asked (offline, not logged in).
 * `onMoved` is told each run it finished, e.g. to clean it up.
 */
export function reconcilePullRequests(store: Store, project: Project, github: GithubPort, config: FactoryConfig, onMoved?: (runId: string) => void): string[] {
  const machine = new RunMachine(store, config);
  const now = new Date().toISOString();
  const runs = store
    .listRuns({ project_id: project.id })
    .filter((r) => !isTerminal(r.state) && r.pr_number !== null && !(r.lease_expires_at !== null && r.lease_expires_at > now));
  const lines: string[] = [];
  for (const run of runs) {
    let pr;
    try {
      pr = github.pullRequestState(run.pr_number!);
    } catch (err) {
      lines.push(`warning: could not check PR #${run.pr_number} of ${run.id}: ${(err as Error).message}`);
      continue;
    }
    if (pr.state === "open") continue;
    try {
      const moved = machine.closeByPullRequest(run.id, pr);
      lines.push(`${run.id}: PR #${pr.number} ${pr.state} -> ${moved.state}`);
      onMoved?.(run.id);
    } catch (err) {
      // E.g. a worker took the run in the meantime; it is checked again next time.
      lines.push(`warning: could not finish ${run.id}: ${(err as Error).message}`);
    }
  }
  return lines;
}
