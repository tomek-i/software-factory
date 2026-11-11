/** Pipeline stages a run moves through, in order. */
export const STAGES = [
  "intake",
  "triage",
  "refine",
  "critic",
  "build",
  "gate",
  "review",
  "capture",
  "pr",
  "merge",
  "learn",
] as const;

/** States where a run is parked or finished rather than being worked on. */
export const PARKED_STATES = ["needs_info", "needs_human"] as const;
export const TERMINAL_STATES = ["done", "rejected", "failed", "cancelled"] as const;

export const RUN_STATES = [...STAGES, ...PARKED_STATES, ...TERMINAL_STATES] as const;

export type Stage = (typeof STAGES)[number];
export type RunState = (typeof RUN_STATES)[number];

export function isTerminal(state: RunState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** Checkpoints where a run can be held for a human, depending on the gate mode. */
export const GATES = ["issue_writer", "triage", "critic", "plan", "review", "pr", "merge"] as const;
export type Gate = (typeof GATES)[number];

/**
 * always: pass straight through.
 * auto:   the agent decides to proceed or escalate (with reasons).
 * human:  always stop until a human approves.
 */
export const GATE_MODES = ["always", "auto", "human"] as const;
export type GateMode = (typeof GATE_MODES)[number];
