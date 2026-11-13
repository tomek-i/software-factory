import type { CommandRunner } from "@factory/core";
import { withProject } from "../context.js";
import { sweepFinishedRuns } from "./reconcile.js";

/**
 * `factory cleanup [--dry-run]`: remove the worktrees and branches of finished runs that still have
 * them, e.g. from before cleanup existed. Like the sweep in `factory status` it leaves runs that
 * finished in the last 2 minutes to their worker; unlike it, it looks again at runs it kept because
 * of unpushed work, in case that work has been pushed since.
 */
export function runCleanup(cwd: string, options: { dryRun?: boolean } = {}, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const lines = sweepFinishedRuns(store, project, config, { run, dryRun: options.dryRun, recheckKept: true });
      if (lines.length === 0) return "Nothing to clean up.";
      return options.dryRun ? `${lines.join("\n")}\n\nNothing was removed (--dry-run).` : lines.join("\n");
    },
    run,
  );
}
