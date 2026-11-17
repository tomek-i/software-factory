import { cleanupRuns, type CommandRunner } from "@factory/core";
import { withProject } from "../context.js";
import { plain, type Style } from "../style.js";

/**
 * `factory cleanup [--dry-run] [--now]`: remove the worktrees and branches of finished runs that still
 * have them, e.g. from before cleanup existed or merged by hand. Like the sweep in `factory status`
 * it leaves runs that finished in the last 2 minutes to their worker, unless `--now`; a run a worker
 * still holds is always left to it. Unlike the sweep, it looks again at runs it kept because of
 * unpushed work, in case that work has been pushed since, and it lists the runs it left alone.
 */
export function runCleanup(cwd: string, options: { dryRun?: boolean; now?: boolean } = {}, run?: CommandRunner, style: Style = plain): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const { lines, skipped } = cleanupRuns(store, project, config, { run, dryRun: options.dryRun, now: options.now });
      if (lines.length === 0 && skipped.length === 0) return "Nothing to clean up.";
      const parts = [];
      if (lines.length) parts.push(lines.join("\n"));
      if (skipped.length) parts.push(["Left alone:", ...skipped.map((s) => `  ${s.runId}: ${s.why}`)].join("\n"));
      if (options.dryRun) parts.push(style.detail("Nothing was removed (--dry-run)."));
      return parts.join("\n\n");
    },
    run,
  );
}
