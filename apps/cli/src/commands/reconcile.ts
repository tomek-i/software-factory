import { cleanupFinishedRun, cleanupFinishedRuns, describeCleanup, ghPort, reconcilePullRequests, runDirOf, type CommandRunner, type GithubPort, type Project, type Store } from "@factory/core";
import type { FactoryConfig } from "@factory/shared";

/**
 * Finish runs whose PR was merged or closed on GitHub since the factory last looked. Returns the
 * lines to print: one per run that moved, or a warning. Never throws, so a GitHub outage or a
 * missing login never stops the command that asked.
 */
export function reconcileRuns(store: Store, project: Project, config: FactoryConfig, deps: { github?: GithubPort; run?: CommandRunner }, onMoved?: (runId: string) => void): string[] {
  // Without a GitHub repository no run has a PR.
  if (!deps.github && !project.github_repo) return [];
  try {
    return reconcilePullRequests(store, project, deps.github ?? ghPort(project, deps.run), config, onMoved);
  } catch (err) {
    return [`warning: could not check pull requests: ${(err as Error).message}`];
  }
}

/**
 * reconcileRuns, then clean up: the runs it finished right away (no worker holds them, or it would
 * have left them alone), and other finished runs through the sweep. Returns the lines to print.
 */
export function reconcileAndSweep(store: Store, project: Project, config: FactoryConfig, deps: { github?: GithubPort; run?: CommandRunner }): string[] {
  const moved: string[] = [];
  const lines = reconcileRuns(store, project, config, deps, (id) => moved.push(id));
  for (const id of moved) lines.push(...cleanUpNow(store, project, config, id, deps.run));
  return [...lines, ...sweepFinishedRuns(store, project, config, deps)];
}

/**
 * Remove the worktrees and branches of finished runs that still have them (see cleanupFinishedRuns):
 * runs whose PR was merged by hand, or that finished before cleanup existed. Never throws.
 */
export function sweepFinishedRuns(store: Store, project: Project, config: FactoryConfig, deps: { run?: CommandRunner; dryRun?: boolean; recheckKept?: boolean }): string[] {
  try {
    return cleanupFinishedRuns(store, project, {
      defaultBranch: config.project.default_branch,
      runDirOf: (id) => runDirOf(project.repo_path, id),
      run: deps.run,
      dryRun: deps.dryRun,
      recheckKept: deps.recheckKept,
    });
  } catch (err) {
    return [`warning: could not clean up finished runs: ${(err as Error).message.split("\n")[0]}`];
  }
}

/** Clean up one run that just finished and that no worker drives. Returns the lines to print. */
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
