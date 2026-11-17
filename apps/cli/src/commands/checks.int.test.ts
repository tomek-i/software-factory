import type { CodeScanningAlert, GithubPort, RequiredCheck } from "@factory/core";
import { describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUT } from "../../../../packages/core/test/helpers.js";
import { github, setup } from "../../test/runs-setup.js";
import { runChecksList, runDismiss } from "./checks.js";

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const alert = (number: number, line: number): CodeScanningAlert => ({
  number,
  rule: "js/missing-rate-limiting",
  description: "Missing rate limiting",
  severity: "high",
  tool: "CodeQL",
  file: "src/drafts.ts",
  line,
  url: `https://github.com/o/r/security/code-scanning/${number}`,
});

/** A run of issue 12 parked after its required checks failed on PR #7, and a GitHub that holds them. */
function parked(alerts: CodeScanningAlert[], failing: RequiredCheck[]) {
  const s = setup([]);
  const store = s.db();
  const run = store.createRun({ project_id: s.projectId, title: "Add the feature", issue_number: 12 });
  store.writeState(run.id, "needs_human", { parked_from: "merge", pr_number: 7 });
  store.close();
  const open = [...alerts];
  const dismissed: { alert: number; reason: string; comment: string }[] = [];
  const gh: GithubPort = {
    ...github,
    // CodeQL passes once no alert of it is open.
    requiredChecks: () => [...failing, { name: "CodeQL", bucket: open.length ? "fail" : "pass", link: "https://github.com/o/r/runs/1" }],
    codeScanningAlerts: () => [...open],
    dismissCodeScanningAlert: (n, reason, comment) => {
      dismissed.push({ alert: n, reason, comment });
      open.splice(
        open.findIndex((a) => a.number === n),
        1,
      );
    },
  };
  return { ...s, run, gh, dismissed };
}

describe("factory checks and factory dismiss", () => {
  it("lists the failed checks with their alerts, and says a failed check that is not code scanning goes to the builder", () => {
    const { dir, run, gh } = parked([alert(26, 317)], [{ name: "test", bucket: "fail" }]);

    const text = runChecksList(dir, "#12", { github: gh });

    expect(text).toContain(`PR #7 of ${run.id}: 2 required checks failed.`);
    expect(text).toContain("test: a required check the factory cannot accept; send the run to the builder:");
    expect(text).toContain(`factory resume ${run.id} --to build --reset-loops`);
    expect(text).toContain("CodeQL (https://github.com/o/r/runs/1): code scanning, 1 open alert");
    expect(text).toContain("#26 (CodeQL js/missing-rate-limiting at src/drafts.ts:317) high: Missing rate limiting");
    expect(text).toContain("https://github.com/o/r/security/code-scanning/26");
  });

  it("dismisses an alert as a human decision, keeps waiting while alerts are left, and goes back to merge once the check passes", () => {
    const { dir, run, gh, dismissed, db } = parked([alert(26, 317), alert(27, 320)], []);

    expect(() => runDismiss(dir, "#12", "26", { reason: "nonsense", message: "x" }, { github: gh })).toThrow(/--reason must be one of: false-positive, wont-fix, used-in-tests/);
    expect(() => runDismiss(dir, "#12", "26", { reason: "false-positive", message: " " }, { github: gh })).toThrow(/Say why with -m/);
    expect(() => runDismiss(dir, "#12", "99", { reason: "false-positive", message: "x" }, { github: gh })).toThrow(/Alert #99 is not an open code scanning alert/);
    expect(dismissed).toEqual([]);

    expect(runDismiss(dir, "#12", "26", { reason: "false-positive", message: "a limiter covers every route" }, { github: gh })).toBe(
      `Dismissed alert #26 (CodeQL js/missing-rate-limiting at src/drafts.ts:317) as false positive.\nStill failing on the PR: CodeQL. The run keeps waiting; \`factory checks ${run.id}\` lists what is left.`,
    );
    let store = db();
    expect(store.getRun(run.id)?.state).toBe("needs_human");
    store.close();

    expect(runDismiss(dir, "#12", "#27", { reason: "wont-fix", message: "same limiter" }, { github: gh })).toContain(`CodeQL passes now; ${run.id} goes back to merge. Continue with \`factory run 12\`.`);
    expect(dismissed).toEqual([
      { alert: 26, reason: "false positive", comment: "a limiter covers every route" },
      { alert: 27, reason: "won't fix", comment: "same limiter" },
    ]);
    store = db();
    expect(store.getRun(run.id)).toMatchObject({ state: "merge", parked_from: null });
    expect(store.listDecisions(run.id).map((d) => [d.actor, d.outcome, d.comment])).toEqual([
      ["human", "approve", "dismissed code scanning alert #26 (CodeQL js/missing-rate-limiting at src/drafts.ts:317) as false positive: a limiter covers every route"],
      ["human", "approve", "dismissed code scanning alert #27 (CodeQL js/missing-rate-limiting at src/drafts.ts:320) as won't fix: same limiter"],
      ["human", "approve", "CodeQL passes after dismissing alert #27"],
    ]);
    expect(store.listEvents(run.id).at(-1)?.data).toMatchObject({ dismissed: { alert: 27, rule: "js/missing-rate-limiting", reason: "won't fix", comment: "same limiter" } });
    store.close();
  });
});
