import { initRepo, type CommandRunner, type InitResult } from "@factory/core";
import { plain, type Style } from "../style.js";
import { runSync } from "./issues.js";

const ICON: Record<InitResult["steps"][number]["status"], string> = {
  done: "+",
  skipped: "-",
  warning: "!",
};

export interface InitOptions {
  /** Pull issues from GitHub once the repo is set up, as `factory sync` does. */
  sync?: boolean;
}

/** Returns the text to print, so the command can be tested without capturing stdout. */
export function runInit(cwd: string, run?: CommandRunner, style: Style = plain, options: InitOptions = {}): string {
  const result = initRepo({ cwd, run });
  const icon: Record<InitResult["steps"][number]["status"], (text: string) => string> = {
    done: style.success,
    skipped: style.detail,
    warning: style.warning,
  };
  const lines = [
    `Initialised software factory in ${result.root}`,
    ...result.steps.map((s) => `  ${icon[s.status](ICON[s.status])} ${s.status === "warning" ? style.warning(s.message) : s.message}`),
  ];
  let synced = false;
  if (options.sync) {
    // The repo is set up by now, so a failed sync (gh logged out, offline) is a warning, not a failed init.
    try {
      lines.push(`  ${style.success("+")} ${runSync(cwd, run, undefined, style)}`);
      synced = true;
    } catch (err) {
      const message = `Could not sync issues: ${err instanceof Error ? err.message : String(err)}`;
      lines.push(`  ${style.warning("!")} ${style.warning(message)}`);
    }
  }
  lines.push(
    "",
    style.hint(
      synced
        ? "Next: review .factory/config.yaml (especially the checks), then commit it."
        : "Next: review .factory/config.yaml (especially the checks), commit it, then run `factory sync` to pull issues.",
    ),
  );
  return lines.join("\n");
}
