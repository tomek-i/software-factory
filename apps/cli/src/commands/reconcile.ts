import { ghPort, reconcilePullRequests, type CommandRunner, type GithubPort, type Project, type Store } from "@factory/core";
import type { FactoryConfig } from "@factory/shared";

/**
 * Finish runs whose PR was merged or closed on GitHub since the factory last looked. Returns the
 * lines to print: one per run that moved, or a warning. Never throws, so a GitHub outage or a
 * missing login never stops the command that asked.
 */
export function reconcileRuns(store: Store, project: Project, config: FactoryConfig, deps: { github?: GithubPort; run?: CommandRunner }): string[] {
  // Without a GitHub repository no run has a PR.
  if (!deps.github && !project.github_repo) return [];
  try {
    return reconcilePullRequests(store, project, deps.github ?? ghPort(project, deps.run), config);
  } catch (err) {
    return [`warning: could not check pull requests: ${(err as Error).message}`];
  }
}
