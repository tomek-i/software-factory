import type { RunState } from "@factory/shared";

export type Tone = "active" | "waiting" | "good" | "bad" | "quiet";

/** The CLI's meanings (`apps/cli/src/style.ts`): every state has one, so a new state can't go unstyled. */
export const STATE_TONE: Record<RunState, Tone> = {
  intake: "active",
  triage: "active",
  refine: "active",
  critic: "active",
  build: "active",
  gate: "active",
  review: "active",
  capture: "active",
  pr: "active",
  merge: "active",
  learn: "active",
  needs_info: "waiting",
  needs_human: "waiting",
  done: "good",
  rejected: "bad",
  failed: "bad",
  cancelled: "quiet",
};

export const TONE_CLASS: Record<Tone, string> = {
  active: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  waiting: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  bad: "bg-red-500/15 text-red-700 dark:text-red-300",
  quiet: "bg-muted text-muted-foreground",
};
