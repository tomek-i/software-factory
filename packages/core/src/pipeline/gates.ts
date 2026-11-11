import type { GateMode } from "@factory/shared";

export interface GateInput {
  mode: GateMode;
  /** The agent's own call, required for `auto` mode. */
  agentDecision?: { decision: "PROCEED" | "ESCALATE"; reasons?: string[] };
  /** Hard-rule hits found in the diff (protected paths, new dependency, ...). */
  hardRuleHits: string[];
  /** Per-run --unsafe flag. Never sourced from config. */
  unsafe: boolean;
}

export interface GateResult {
  outcome: "proceed" | "wait_human";
  reasons: string[];
}

/** Decide whether a run may pass a gate or must wait for a human. */
export function resolveGate(input: GateInput): GateResult {
  if (input.hardRuleHits.length > 0 && !input.unsafe) {
    return { outcome: "wait_human", reasons: input.hardRuleHits.map((h) => `hard rule: ${h}`) };
  }
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
