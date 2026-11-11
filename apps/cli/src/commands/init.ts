import { initRepo, type CommandRunner, type InitResult } from "@factory/core";

const ICON: Record<InitResult["steps"][number]["status"], string> = {
  done: "+",
  skipped: "-",
  warning: "!",
};

/** Returns the text to print, so the command can be tested without capturing stdout. */
export function runInit(cwd: string, run?: CommandRunner): string {
  const result = initRepo({ cwd, run });
  const lines = [
    `Initialised software factory in ${result.root}`,
    ...result.steps.map((s) => `  ${ICON[s.status]} ${s.message}`),
    "",
    "Next: review .factory/config.yaml (especially the checks), then commit it.",
  ];
  return lines.join("\n");
}
