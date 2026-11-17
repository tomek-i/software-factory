import type { FactoryConfig } from "@factory/shared";
import { ghPort, type GithubPort } from "../github/port.js";
import { cleanupFinishedRun, cleanupFinishedRuns, describeCleanup } from "../pipeline/cleanup.js";
import { runDirOf } from "../pipeline/driver.js";
import { reconcileWithGithub } from "../pipeline/reconcile.js";
import type { Project, Store } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";

/**
 * Finish runs whose PR was merged or closed, or whose issue was closed, on GitHub since the factory
 * last looked (see reconcileWithGithub). Returns one line per run that moved, or a warning. Never throws, so a GitHub outage or a missing login never
 * stops the action that asked.
 */
export function reconcileRuns(
  store: Store,
  project: Project,
  config: FactoryConfig,
  deps: { github?: GithubPort; run?: CommandRunner },
  onMoved?: (runId: string) => void,
): string[] {
  // Without a GitHub repository no run has a PR or an issue on GitHub.
  if (!deps.github && !project.github_repo) return [];
  try {
    return reconcileWithGithub(store, project, deps.github ?? ghPort(project, deps.run), config, onMoved);
  } catch (err) {
    return [`warning: could not check GitHub: ${(err as Error).message}`];
  }
}

/** What reconcileAndSweep did, as lines in the order it happened. */
export interface ReconcileReport {
  /** Runs finished because their PR was merged or closed, or their issue was closed. */
  moved: string[];
  /** From reconcileRuns: the runs that moved, and warnings. */
  reconciled: string[];
  /** From cleaning up the runs that moved. */
  cleaned: string[];
  /** From the sweep of other finished runs. */
  swept: string[];
}

/** Every line of a ReconcileReport, in order. */
export function reportLines(report: ReconcileReport): string[] {
  return [...report.reconciled, ...report.cleaned, ...report.swept];
}

/**
 * reconcileRuns, then clean up: the runs it finished right away (no worker holds them, or it would
 * have left them alone), and other finished runs through the sweep.
 */
export function reconcileAndSweep(store: Store, project: Project, config: FactoryConfig, deps: { github?: GithubPort; run?: CommandRunner }): ReconcileReport {
  const moved: string[] = [];
  const reconciled = reconcileRuns(store, project, config, deps, (id) => moved.push(id));
  const cleaned = moved.flatMap((id) => cleanUpNow(store, project, config, id, deps.run));
  return { moved, reconciled, cleaned, swept: sweepFinishedRuns(store, project, config, deps) };
}

/**
 * Remove the worktrees and branches of finished runs that still have them (see cleanupFinishedRuns):
 * runs whose PR was merged by hand, or that finished before cleanup existed. Never throws.
 */
export function sweepFinishedRuns(
  store: Store,
  project: Project,
  config: FactoryConfig,
  deps: { run?: CommandRunner; dryRun?: boolean; recheckKept?: boolean; graceMs?: number; onSkipped?: (runId: string, why: string) => void },
): string[] {
  try {
    return cleanupFinishedRuns(store, project, {
      defaultBranch: config.project.default_branch,
      runDirOf: (id) => runDirOf(project.repo_path, id),
      run: deps.run,
      dryRun: deps.dryRun,
      recheckKept: deps.recheckKept,
      graceMs: deps.graceMs,
      onSkipped: deps.onSkipped,
    });
  } catch (err) {
    return [`warning: could not clean up finished runs: ${(err as Error).message.split("\n")[0]}`];
  }
}

/** What `factory cleanup` and the web app's cleanup did: removed and kept (`lines`), and the runs it left alone. */
export interface CleanupReport {
  lines: string[];
  skipped: { runId: string; why: string }[];
}

/**
 * Clean up every finished run that still has its worktree, as the sweep does, and also look again at
 * runs kept because of unpushed work, in case it has been pushed since. `now` skips the wait after a
 * run finished; a run a worker still holds is always left to it.
 */
export function cleanupRuns(store: Store, project: Project, config: FactoryConfig, options: { run?: CommandRunner; dryRun?: boolean; now?: boolean } = {}): CleanupReport {
  const skipped: CleanupReport["skipped"] = [];
  const lines = sweepFinishedRuns(store, project, config, {
    run: options.run,
    dryRun: options.dryRun,
    recheckKept: true,
    graceMs: options.now ? 0 : undefined,
    onSkipped: (runId, why) => skipped.push({ runId, why }),
  });
  return { lines, skipped };
}

/** Clean up one run that just finished and that no worker drives. Returns its lines. */
export function cleanUpNow(store: Store, project: Project, config: FactoryConfig, runId: string, run?: CommandRunner): string[] {
  const target = store.getRun(runId);
  if (!target) return [];
  try {
    const result = cleanupFinishedRun(store, target, { root: project.repo_path, runDir: runDirOf(project.repo_path, runId), defaultBranch: config.project.default_branch, run });
    return describeCleanup(runId, result);
  } catch (err) {
    return [`warning: could not clean up ${runId}: ${(err as Error).message.split("\n")[0]}`];
  }
}
