import type { CommandRunner } from "@factory/core";
import { withProject } from "../context.js";
import { sweepFinishedRuns } from "./reconcile.js";

/**
 * `factory cleanup [--dry-run]`: remove the worktrees and branches of finished runs that still have
 * them, e.g. from before cleanup existed. Unlike the sweep in `factory status`, it does not wait for
 * runs that finished in the last minutes; a run a worker still holds is left alone.
 */
export function runCleanup(cwd: string, options: { dryRun?: boolean } = {}, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const lines = sweepFinishedRuns(store, project, config, { run, dryRun: options.dryRun, graceMs: 0 });
      if (lines.length === 0) return "Nothing to clean up.";
      return options.dryRun ? `${lines.join("\n")}\n\nNothing was removed (--dry-run).` : lines.join("\n");
    },
    run,
  );
}
