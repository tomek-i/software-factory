import { parseConfig, resetConfig, RESETTABLE_SECTIONS, type CommandRunner } from "@factory/core";
import { CliError } from "../context.js";
import { plain, type Style } from "../style.js";

/** Returns the text to print, so the command can be tested without capturing stdout. */
export function runConfigReset(cwd: string, settings: string[], options: { all?: boolean }, run?: CommandRunner, style: Style = plain): string {
  if (options.all && settings.length) throw new CliError("name settings to reset or use --all, not both");
  if (!options.all && !settings.length) {
    throw new CliError(`name the settings to reset, e.g. \`factory config reset models\`, or use --all (sections: ${RESETTABLE_SECTIONS.join(", ")})`);
  }
  const result = resetConfig({ cwd, target: options.all ? { all: true } : { paths: settings }, run });
  const lines = result.notSet.map((path) => style.detail(`- ${path} is not set in the file, so it already uses the default`));
  if (!result.removed.length) return [...lines, "Nothing to reset: .factory/config.yaml is unchanged."].join("\n");
  // The factory reads its config from the default branch, never the working tree (see config/trusted.ts).
  const branch = parseConfig(result.text, result.path).project.default_branch;
  return [
    style.success(`Reset ${result.removed.join(", ")} in .factory/config.yaml: the defaults apply now.`),
    ...lines,
    style.hint(`Commit the change and merge it into ${branch}: runs read the config from origin/${branch}.`),
  ].join("\n");
}
