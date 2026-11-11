import type { GateMode } from "@factory/shared";

export interface GateInput {
  mode: GateMode;
  /** The agent's own call, required for `auto` mode. */
  agentDecision?: { decision: "PROCEED" | "ESCALATE"; reasons?: string[] };
  /** Hard-rule hits found in the diff (protected paths, new dependency, ...). */
  hardRuleHits: string[];
  /** Per-run --unsafe flag. Never sourced from config. Lifts hard rules only. */
  unsafe: boolean;
  /**
   * Reasons that always need a human regardless of mode and --unsafe, e.g. the issue was written
   * by an untrusted author, so its text may be trying to steer the agents.
   */
  forceHumanReasons?: string[];
}

export interface GateResult {
  outcome: "proceed" | "wait_human";
  reasons: string[];
}

/** Decide whether a run may pass a gate or must wait for a human. */
export function resolveGate(input: GateInput): GateResult {
  const forced = input.forceHumanReasons?.filter((r) => r.trim()) ?? [];
  const hard = input.unsafe ? [] : input.hardRuleHits.map((h) => `hard rule: ${h}`);
  if (forced.length || hard.length) return { outcome: "wait_human", reasons: [...forced, ...hard] };

  switch (input.mode) {
    case "always":
      return { outcome: "proceed", reasons: [] };
    case "human":
      return { outcome: "wait_human", reasons: ["gate is set to human"] };
    case "auto": {
      if (!input.agentDecision) return { outcome: "wait_human", reasons: ["agent gave no decision"] };
      if (input.agentDecision.decision === "PROCEED") return { outcome: "proceed", reasons: [] };
      const reasons = input.agentDecision.reasons?.filter((r) => r.trim()) ?? [];
      return { outcome: "wait_human", reasons: reasons.length ? reasons : ["agent escalated without reasons"] };
    }
  }
}
