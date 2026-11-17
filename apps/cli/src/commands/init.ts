import { initRepo, type CommandRunner, type InitResult } from "@factory/core";
import { plain, type Style } from "../style.js";

const ICON: Record<InitResult["steps"][number]["status"], string> = {
  done: "+",
  skipped: "-",
  warning: "!",
};

/** Returns the text to print, so the command can be tested without capturing stdout. */
export function runInit(cwd: string, run?: CommandRunner, style: Style = plain): string {
  const result = initRepo({ cwd, run });
  const icon: Record<InitResult["steps"][number]["status"], (text: string) => string> = {
    done: style.success,
    skipped: style.detail,
    warning: style.warning,
  };
  const lines = [
    `Initialised software factory in ${result.root}`,
    ...result.steps.map((s) => `  ${icon[s.status](ICON[s.status])} ${s.status === "warning" ? style.warning(s.message) : s.message}`),
    "",
    style.hint("Next: review .factory/config.yaml (especially the checks), then commit it."),
  ];
  return lines.join("\n");
}
