import { ghPort, DISMISS_COMMENT_MAX, DISMISS_REASONS, type CodeScanningAlert, type DismissReason, type GithubPort } from "../github/port.js";
import { RunMachine } from "../pipeline/transitions.js";
import type { Run } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { ServiceError } from "./errors.js";
import { findRun, trustedConfig, type ServiceContext } from "./runs.js";

/** A required check that failed on the run's PR. */
export interface FailedCheck {
  name: string;
  link?: string;
  /**
   * Open alerts of the code scanning tool this check reports for. Empty when the check is not code
   * scanning: then only the builder can fix it, since branch protection refuses the merge anyway.
   */
  alerts: CodeScanningAlert[];
}

export interface RunChecks {
  run: Run;
  pr: number;
  failed: FailedCheck[];
  /** Open alerts on the PR that no failed check reports, e.g. below the severity that fails it. */
  otherAlerts: CodeScanningAlert[];
}

/** `factory dismiss --reason` values, as GitHub's reasons. */
export const DISMISS_REASON_FLAGS: Record<string, DismissReason> = {
  "false-positive": "false positive",
  "wont-fix": "won't fix",
  "used-in-tests": "used in tests",
};

export interface Dismissed {
  /** The run as it is after the dismissal. */
  run: Run;
  alert: CodeScanningAlert;
  /** The failed check the alert belonged to. */
  check: string;
  /** Required checks still failing on the PR once GitHub re-read them. */
  failing: string[];
  /** No required check failed any more, so the run went back to merge. */
  continued: boolean;
}

/**
 * Whether a check reports for a code scanning tool: GitHub names the check after the tool, e.g.
 * "CodeQL", sometimes with a suffix such as "CodeQL (javascript)".
 */
function reportsFor(check: string, tool: string): boolean {
  const name = check.toLowerCase();
  const t = tool.toLowerCase();
  return name === t || name.startsWith(`${t} `) || name.startsWith(`${t}(`);
}

function githubOf(ctx: ServiceContext, deps: { github?: GithubPort; run?: CommandRunner }): GithubPort {
  return deps.github ?? ghPort(ctx.project, deps.run);
}

const failedOf = (github: GithubPort, pr: number) => github.requiredChecks(pr).filter((c) => c.bucket === "fail" || c.bucket === "cancel");

/** The required checks that failed on a run's PR, each with its open code scanning alerts. */
export function runChecks(ctx: ServiceContext, ref: string, deps: { github?: GithubPort; run?: CommandRunner } = {}): RunChecks {
  const target = findRun(ctx.store, ctx.project, ref);
  if (target.pr_number === null) throw new ServiceError(`Run ${target.id} has no pull request.`);
  const github = githubOf(ctx, deps);
  return checksOf(github, target, target.pr_number);
}

function checksOf(github: GithubPort, run: Run, pr: number): RunChecks {
  const failedChecks = failedOf(github, pr);
  const alerts = github.codeScanningAlerts(pr);
  const failed = failedChecks.map((c) => ({
    name: c.name,
    ...(c.link ? { link: c.link } : {}),
    alerts: alerts.filter((a) => reportsFor(c.name, a.tool)),
  }));
  const otherAlerts = alerts.filter((a) => !failed.some((c) => c.alerts.includes(a)));
  return { run, pr, failed, otherAlerts };
}

/** "#26 (CodeQL js/missing-rate-limiting at src/a.ts:12)" */
export function describeAlert(alert: CodeScanningAlert): string {
  const where = alert.file ? ` at ${alert.file}${alert.line ? `:${alert.line}` : ""}` : "";
  return `#${alert.number} (${alert.tool} ${alert.rule}${where})`;
}

/**
 * A human dismisses a code scanning alert of a failed required check on the run's PR, e.g. a false
 * positive no build round could fix. Recorded as the human's decision on the run. When GitHub then
 * reports no failing required check, the run goes back to merge, which checks everything again on
 * the same head; otherwise it keeps waiting. Never called by an agent or a stage.
 */
export function dismissAlert(
  ctx: ServiceContext,
  ref: string,
  options: { alert: number; reason: string; comment: string },
  deps: { github?: GithubPort; run?: CommandRunner } = {},
): Dismissed {
  const comment = options.comment?.trim() ?? "";
  if (!comment) throw new ServiceError("Say why with -m.");
  if (comment.length > DISMISS_COMMENT_MAX) throw new ServiceError(`GitHub takes at most ${DISMISS_COMMENT_MAX} characters for the reason; this one has ${comment.length}.`);
  if (!DISMISS_REASONS.includes(options.reason as DismissReason)) throw new ServiceError(`The reason must be one of: ${DISMISS_REASONS.join(", ")}.`);
  const reason = options.reason as DismissReason;
  if (!Number.isInteger(options.alert) || options.alert <= 0) throw new ServiceError(`"${options.alert}" is not an alert number.`);

  const { store, project } = ctx;
  const target = findRun(store, project, ref);
  if (target.state !== "needs_human" || target.parked_from !== "merge" || target.pr_number === null) {
    throw new ServiceError(`Run ${target.id} is not waiting on failed checks of its pull request (it is ${target.state}).`);
  }
  const pr = target.pr_number;
  const github = githubOf(ctx, deps);
  // Only an alert behind a check that stops this run: a run's page is no way to dismiss others.
  const check = checksOf(github, target, pr).failed.find((c) => c.alerts.some((a) => a.number === options.alert));
  const alert = check?.alerts.find((a) => a.number === options.alert);
  if (!check || !alert) throw new ServiceError(`Alert #${options.alert} is not an open code scanning alert of a failed required check on PR #${pr}.`);

  github.dismissCodeScanningAlert(alert.number, reason, comment);
  const trusted = trustedConfig(project, ctx.config, deps.run);
  const gate = target.waiting_gate ?? "escalation";
  store.recordDecision({
    run_id: target.id,
    gate,
    mode: target.waiting_gate ? trusted.gates[target.waiting_gate] : "human",
    outcome: "approve",
    actor: "human",
    comment: `dismissed code scanning alert ${describeAlert(alert)} as ${reason}: ${comment}`,
  });

  // GitHub updates the check in place once the alert is dismissed: no re-run is needed.
  const failing = failedOf(github, pr).map((c) => c.name);
  if (failing.length) return { run: store.getRun(target.id)!, alert, check: check.name, failing, continued: false };
  // No commit: the earlier merge approval still covers this head, and the merge stage checks everything again.
  new RunMachine(store, trusted).resume(target.id, "merge", {
    comment: `${check.name} passes after dismissing alert #${alert.number}`,
    data: { dismissed: { alert: alert.number, rule: alert.rule, tool: alert.tool, reason, comment } },
  });
  return { run: store.getRun(target.id)!, alert, check: check.name, failing, continued: true };
}
