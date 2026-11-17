import { describe, expect, it } from "vitest";
import { setup } from "../../test/driver-setup.js";
import { loadConfig } from "../config/load.js";
import type { CodeScanningAlert } from "../github/port.js";
import { dismissAlert, runChecks } from "./checks.js";
import { ServiceError } from "./errors.js";
import { resumeRun, type ServiceContext } from "./runs.js";

const alert = (number: number, tool = "CodeQL"): CodeScanningAlert => ({
  number,
  rule: "js/missing-rate-limiting",
  description: "Missing rate limiting",
  severity: "high",
  tool,
  file: "src/drafts.ts",
  line: 300 + number,
  url: `https://github.com/o/r/security/code-scanning/${number}`,
});

/** A run of issue 12 parked by the merge stage, its PR #7 failing CodeQL with the given alerts open. */
function parkedOnChecks(alerts: CodeScanningAlert[]) {
  const s = setup([]);
  const ctx: ServiceContext = { store: s.store, project: s.project, config: loadConfig(s.root) };
  const run = s.store.createRun({ project_id: s.project.id, title: "t", issue_number: 12 });
  s.store.writeState(run.id, "needs_human", { parked_from: "merge", pr_number: 7, review_rounds: 2 });
  s.pr.alerts = alerts;
  s.pr.checks = [[{ name: "CodeQL", bucket: "fail", link: "https://ci/1" }, { name: "test", bucket: "pass" }]];
  s.pr.checksWhenClear = [{ name: "CodeQL", bucket: "pass" }, { name: "test", bucket: "pass" }];
  return { ...s, ctx, run };
}

describe("runChecks", () => {
  it("gives each failed required check the open alerts of its code scanning tool", () => {
    const { ctx, run, pr, github } = parkedOnChecks([alert(26), alert(3, "Semgrep")]);
    pr.checks = [[{ name: "CodeQL", bucket: "fail" }, { name: "build", bucket: "cancel" }, { name: "lint", bucket: "pass" }]];

    const checks = runChecks(ctx, run.id, { github });

    expect(checks.failed).toEqual([
      { name: "CodeQL", alerts: [alert(26)] },
      { name: "build", alerts: [] },
    ]);
    expect(checks.otherAlerts).toEqual([alert(3, "Semgrep")]);
    ctx.store.writeState(run.id, "needs_human", { pr_number: null });
    expect(() => runChecks(ctx, run.id, { github })).toThrow(new ServiceError(`Run ${run.id} has no pull request.`));
  });
});

describe("dismissAlert", () => {
  it("keeps the run waiting while the check still fails, recording the human's decision", () => {
    const { ctx, run, dismissals, store, github } = parkedOnChecks([alert(26), alert(27)]);

    const result = dismissAlert(ctx, run.id, { alert: 26, reason: "false positive", comment: "a limiter covers every route" }, { github });

    expect(result).toMatchObject({ check: "CodeQL", failing: ["CodeQL"], continued: false, run: { state: "needs_human" } });
    expect(dismissals).toEqual([{ alert: 26, reason: "false positive", comment: "a limiter covers every route" }]);
    expect(store.listDecisions(run.id)).toMatchObject([
      {
        gate: "escalation",
        mode: "human",
        outcome: "approve",
        actor: "human",
        comment: "dismissed code scanning alert #26 (CodeQL js/missing-rate-limiting at src/drafts.ts:326) as false positive: a limiter covers every route",
      },
    ]);
  });

  it("sends the run back to merge once the check passes, without a merge approval of its own", () => {
    const { ctx, run, store, github } = parkedOnChecks([alert(26)]);

    const result = dismissAlert(ctx, run.id, { alert: 26, reason: "won't fix", comment: "accepted risk" }, { github });

    expect(result).toMatchObject({ failing: [], continued: true, run: { state: "merge", parked_from: null, review_rounds: 2 } });
    const event = store.listEvents(run.id).at(-1)!;
    expect(event).toMatchObject({ from_state: "needs_human", to_state: "merge", reason: "human: CodeQL passes after dismissing alert #26" });
    expect(event.data).toEqual({
      dismissed: { alert: 26, rule: "js/missing-rate-limiting", tool: "CodeQL", reason: "won't fix", comment: "accepted risk" },
      gate: "escalation",
      resetLoops: false,
    });
  });

  it("refuses what a human may not dismiss here", () => {
    const { ctx, run, dismissals, store, github } = parkedOnChecks([alert(26), alert(3, "Semgrep")]);
    const dismiss = (options: Partial<{ alert: number; reason: string; comment: string }>) =>
      dismissAlert(ctx, run.id, { alert: 26, reason: "false positive", comment: "fine", ...options }, { github });

    expect(() => dismiss({ comment: " " })).toThrow(new ServiceError("Say why with -m."));
    expect(() => dismiss({ comment: "x".repeat(281) })).toThrow(/at most 280 characters/);
    expect(() => dismiss({ reason: "dismissed" })).toThrow(/The reason must be one of: false positive, won't fix, used in tests/);
    expect(() => dismiss({ alert: 1.5 })).toThrow(/not an alert number/);
    // An alert no failed check reports, or one GitHub does not list as open on the PR.
    expect(() => dismiss({ alert: 3 })).toThrow(/Alert #3 is not an open code scanning alert of a failed required check on PR #7/);
    expect(() => dismiss({ alert: 99 })).toThrow(/Alert #99/);
    store.writeState(run.id, "needs_human", { parked_from: "build" });
    expect(() => dismiss({})).toThrow(/is not waiting on failed checks of its pull request/);
    expect(dismissals).toEqual([]);
    expect(store.listDecisions(run.id)).toEqual([]);
  });
});

describe("resumeRun at a gate", () => {
  it("sends a run waiting at the review gate back to build with fresh loops, and refuses a target it may not reach", () => {
    const s = setup([]);
    const ctx: ServiceContext = { store: s.store, project: s.project, config: loadConfig(s.root) };
    const run = s.store.createRun({ project_id: s.project.id, title: "t", issue_number: 12 });
    s.store.writeState(run.id, "needs_human", { parked_from: "review", waiting_gate: "review", review_rounds: 2, build_iterations: 1 });

    expect(() => resumeRun(ctx, run.id, { to: "merge", message: "ship" })).toThrow(/can resume to: .*build/);
    const resumed = resumeRun(ctx, run.id, { to: "build", message: "code-1: the limiter is skipped at src/a.ts:12", resetLoops: true });

    expect(resumed).toMatchObject({ to: "build", run: { state: "build", waiting_gate: null, review_rounds: 0, build_iterations: 0 } });
    expect(s.store.listDecisions(run.id).at(-1)).toMatchObject({ gate: "review", actor: "human", comment: "code-1: the limiter is skipped at src/a.ts:12" });
  });
});
