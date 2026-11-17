import { describe, expect, it, vi } from "vitest";
import type { RequiredCheck } from "../../github/port.js";
import { judgeChecks, type ChecksMoment } from "./merge.js";

const HEAD = "a".repeat(40);
const check = (name: string, bucket: RequiredCheck["bucket"], link?: string): RequiredCheck => ({ name, bucket, ...(link ? { link } : {}) });
/** One look at the checks, in the middle of the wait unless a test says otherwise. */
const at = (moment: Partial<ChecksMoment> = {}): ChecksMoment => ({
  number: 7,
  head: HEAD,
  prHead: () => HEAD,
  now: 1_000,
  deadline: 10_000,
  graceUntil: 0,
  minutes: 30,
  ...moment,
});

describe("judgeChecks", () => {
  it("passes when every required check is done and none failed, marking the skipped ones", () => {
    expect(judgeChecks([check("CodeQL", "pass"), check("docs", "skipping")], at())).toEqual({
      kind: "passed",
      passed: ["CodeQL", "docs (skipped)"],
      required: ["CodeQL", "docs"],
    });
  });

  it("passes with no required checks once the grace after a push is over, and waits during it", () => {
    expect(judgeChecks([], at({ graceUntil: 500 }))).toEqual({ kind: "passed", passed: [], required: [] });
    expect(judgeChecks([], at({ graceUntil: 5_000 }))).toEqual({ kind: "wait", pending: [] });
  });

  it("waits while a check is still running, naming the running ones", () => {
    expect(judgeChecks([check("CodeQL", "pending"), check("build", "pass"), check("lint", "pending")], at())).toEqual({ kind: "wait", pending: ["CodeQL", "lint"] });
  });

  it("does not judge the checks of a commit that is not the one that passed the gate", () => {
    const moved = judgeChecks([check("test", "fail")], at({ prHead: () => "f".repeat(40) }));
    expect(moved).toEqual({ kind: "escalate", reason: "PR #7 moved to fffffff while waiting for checks; only aaaaaaa passed the gate" });
  });

  it("asks GitHub for the PR's head only when there are checks to judge", () => {
    const prHead = vi.fn(() => HEAD);
    judgeChecks([], at({ prHead }));
    expect(prHead).not.toHaveBeenCalled();
    judgeChecks([check("test", "pass")], at({ prHead }));
    expect(prHead).toHaveBeenCalledTimes(1);
  });

  it("hands a failed or cancelled check to a human, naming it with its link", () => {
    expect(judgeChecks([check("test (windows-latest)", "fail", "https://ci/9"), check("build", "pending")], at())).toEqual({
      kind: "escalate",
      reason: "required check failed on PR #7: test (windows-latest) (https://ci/9)",
      failedChecks: [{ name: "test (windows-latest)", link: "https://ci/9" }],
    });
    expect(judgeChecks([check("CodeQL", "fail"), check("e2e", "cancel")], at())).toEqual({
      kind: "escalate",
      reason: "required checks failed on PR #7: CodeQL; e2e",
      failedChecks: [{ name: "CodeQL" }, { name: "e2e" }],
    });
  });

  it("reports a failure even after the deadline, before the timeout", () => {
    expect(judgeChecks([check("CodeQL", "fail")], at({ now: 20_000 }))).toMatchObject({ reason: "required check failed on PR #7: CodeQL" });
  });

  it("stops waiting at the deadline and asks a human, naming what still runs", () => {
    expect(judgeChecks([check("test (ubuntu-latest)", "pending")], at({ now: 10_000, minutes: 0.002 }))).toEqual({
      kind: "escalate",
      reason: "required checks still running on PR #7 after 0.002 min: test (ubuntu-latest)",
    });
    // A grace longer than the timeout: GitHub never reported a check for the pushed commit.
    expect(judgeChecks([], at({ now: 10_000, graceUntil: 60_000 }))).toEqual({
      kind: "escalate",
      reason: "required checks still running on PR #7 after 30 min: none reported yet",
    });
  });
});
