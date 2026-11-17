import { describeAlert, dismissAlert, DISMISS_REASON_FLAGS, runChecks, type CodeScanningAlert, type CommandRunner, type GithubPort } from "@factory/core";
import { CliError, withProject } from "../context.js";
import { plain, type Style } from "../style.js";

export interface ChecksDeps {
  run?: CommandRunner;
  github?: GithubPort;
  /** How to style output; plain unless the caller decided colour is on. */
  style?: Style;
}

function alertLines(alerts: CodeScanningAlert[]): string[] {
  return alerts.flatMap((a) => [`  ${describeAlert(a)} ${a.severity}: ${a.description}`, `    ${a.url}`]);
}

/** `factory checks <run>`: the required checks that failed on the run's PR, and its open code scanning alerts. */
export function runChecksList(cwd: string, ref: string, deps: ChecksDeps = {}): string {
  const style = deps.style ?? plain;
  return withProject(
    cwd,
    (ctx) => {
      const { run, pr, failed, otherAlerts } = runChecks(ctx, ref, deps);
      const of = `PR #${pr} of ${style.detail(run.id)}:`;
      const lines = [
        failed.length
          ? `${of} ${style.check(false, `${failed.length} required check${failed.length > 1 ? "s" : ""} failed`)}.`
          : `${of} ${style.check(true, "no required check failed")}.`,
      ];
      for (const check of failed) {
        const name = check.link ? `${check.name} (${check.link})` : check.name;
        if (check.alerts.length) {
          lines.push("", `${name}: code scanning, ${check.alerts.length} open alert${check.alerts.length > 1 ? "s" : ""}`, ...alertLines(check.alerts));
          lines.push(`  ${style.hint(`A false positive: \`factory dismiss ${run.id} <alert> --reason false-positive -m "<why>"\`.`)}`);
        } else {
          // Branch protection refuses the merge while it fails, so accepting it here would change nothing.
          lines.push("", `${name}: a required check the factory cannot accept; send the run to the builder:`, `  ${style.hint(`\`factory resume ${run.id} --to build --reset-loops -m "<what to fix>"\``)}`);
        }
      }
      if (otherAlerts.length) lines.push("", "Other open code scanning alerts on the PR:", ...alertLines(otherAlerts));
      return lines.join("\n");
    },
    deps.run,
  );
}

/** `factory dismiss <run> <alert> --reason <reason> -m <why>`: dismiss a code scanning alert that stops the run. */
export function runDismiss(cwd: string, ref: string, alert: string, options: { reason: string; message: string }, deps: ChecksDeps = {}): string {
  const reason = DISMISS_REASON_FLAGS[options.reason];
  if (!reason) throw new CliError(`--reason must be one of: ${Object.keys(DISMISS_REASON_FLAGS).join(", ")}.`);
  const number = Number(alert.replace(/^#/, ""));
  if (!Number.isInteger(number) || number <= 0) throw new CliError(`"${alert}" is not an alert number.`);
  return withProject(
    cwd,
    (ctx) => {
      const dismissed = dismissAlert(ctx, ref, { alert: number, reason, comment: options.message }, deps);
      const done = `Dismissed alert ${describeAlert(dismissed.alert)} as ${reason}.`;
      if (dismissed.continued) {
        const issue = dismissed.run.issue_number;
        return `${done}\n${dismissed.check} passes now; ${dismissed.run.id} goes back to merge.${issue === null ? "" : ` Continue with \`factory run ${issue}\`.`}`;
      }
      return `${done}\nStill failing on the PR: ${dismissed.failing.join(", ")}. The run keeps waiting; \`factory checks ${dismissed.run.id}\` lists what is left.`;
    },
    deps.run,
  );
}
