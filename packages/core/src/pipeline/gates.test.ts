import { describe, expect, it } from "vitest";
import { resolveGate } from "./gates.js";

const base = { hardRuleHits: [], unsafe: false };

describe("resolveGate", () => {
  it("always proceeds in always mode", () => {
    expect(resolveGate({ ...base, mode: "always" }).outcome).toBe("proceed");
  });

  it("always waits in human mode, even if the agent says proceed", () => {
    expect(resolveGate({ ...base, mode: "human", agentDecision: { decision: "PROCEED" } }).outcome).toBe("wait_human");
  });

  it("follows the agent in auto mode", () => {
    expect(resolveGate({ ...base, mode: "auto", agentDecision: { decision: "PROCEED" } }).outcome).toBe("proceed");
    expect(
      resolveGate({ ...base, mode: "auto", agentDecision: { decision: "ESCALATE", reasons: ["touches billing"] } }),
    ).toEqual({ outcome: "wait_human", reasons: ["touches billing"] });
  });

  it("escalates in auto mode when the agent gives no decision or no reasons", () => {
    expect(resolveGate({ ...base, mode: "auto" }).outcome).toBe("wait_human");
    expect(resolveGate({ ...base, mode: "auto", agentDecision: { decision: "ESCALATE" } }).reasons).toEqual([
      "agent escalated without reasons",
    ]);
  });

  it("lets hard rules override every mode", () => {
    for (const mode of ["always", "auto", "human"] as const) {
      expect(
        resolveGate({ mode, hardRuleHits: ["path .github/workflows/ci.yml"], unsafe: false, agentDecision: { decision: "PROCEED" } }),
      ).toEqual({ outcome: "wait_human", reasons: ["hard rule: path .github/workflows/ci.yml"] });
    }
  });

  it("always waits for a human on forced reasons such as an untrusted author, even when unsafe", () => {
    expect(
      resolveGate({
        mode: "always",
        hardRuleHits: [],
        unsafe: true,
        forceHumanReasons: ["issue author mallory is not trusted"],
      }),
    ).toEqual({ outcome: "wait_human", reasons: ["issue author mallory is not trusted"] });
  });

  it("lifts hard rules only for unsafe runs, without skipping the gate mode", () => {
    expect(resolveGate({ mode: "always", hardRuleHits: ["new dependency"], unsafe: true }).outcome).toBe("proceed");
    expect(resolveGate({ mode: "human", hardRuleHits: ["new dependency"], unsafe: true }).outcome).toBe("wait_human");
  });
});
