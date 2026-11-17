import { initRepo, type CommandRunner, type InitResult } from "@factory/core";
import { plain, type Style } from "../style.js";
import { runSync } from "./issues.js";

const ICON: Record<InitResult["steps"][number]["status"], string> = {
  done: "+",
  skipped: "-",
  warning: "!",
};

export interface InitCommandOptions {
  /** Pull issues from GitHub once the repo is set up, as `factory sync` does. */
  sync?: boolean;
  /** The project name to set in the config. */
  name?: string;
  /** Turn GitHub status labels on and create them. */
  labels?: boolean;
  /** Say what would happen without writing anything. */
  dryRun?: boolean;
}

/** Returns the text to print, so the command can be tested without capturing stdout. */
export function runInit(cwd: string, run?: CommandRunner, style: Style = plain, options: InitCommandOptions = {}): string {
  const result = initRepo({ cwd, run, name: options.name, labels: options.labels, dryRun: options.dryRun });
  const icon: Record<InitResult["steps"][number]["status"], (text: string) => string> = {
    done: style.success,
    skipped: style.detail,
    warning: style.warning,
  };
  const lines = [
    options.dryRun ? `Dry run in ${result.root}: nothing was written` : `Initialised software factory in ${result.root}`,
    ...result.steps.map((s) => `  ${icon[s.status](ICON[s.status])} ${s.status === "warning" ? style.warning(s.message) : s.message}`),
  ];
  let synced = false;
  if (options.sync && !result.githubRepo) {
    lines.push(`  ${style.warning("!")} ${style.warning("No GitHub origin remote found; skipped syncing issues")}`);
  } else if (options.sync && options.dryRun) {
    lines.push(`  ${style.success("+")} Would sync issues from GitHub`);
  } else if (options.sync) {
    // The repo is set up by now, so a failed sync (gh logged out, offline) is a warning, not a failed init.
    try {
      lines.push(`  ${style.success("+")} ${runSync(cwd, run, undefined, style)}`);
      synced = true;
    } catch (err) {
      const message = `Could not sync issues: ${err instanceof Error ? err.message : String(err)}`;
      lines.push(`  ${style.warning("!")} ${style.warning(message)}`);
    }
  }
  const next = options.dryRun
    ? "Next: run it again without --dry-run to apply."
    : // Syncing needs a GitHub remote, so without one the hint doesn't send you to a command that fails.
      synced || !result.githubRepo
      ? "Next: review .factory/config.yaml (especially the checks), then commit it."
      : "Next: review .factory/config.yaml (especially the checks), commit it, then run `factory sync` to pull issues.";
  lines.push("", style.hint(next));
  return lines.join("\n");
}
