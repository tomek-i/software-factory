import { styleText } from "node:util";
import type { AgentRunStatus } from "@factory/core";
import type { RunState } from "@factory/shared";

/**
 * Terminal styling for CLI output. Commands say what a piece of text is (a run state, an id, a
 * hint); this module alone decides how that looks. Styling never changes the text itself, so
 * output with colour off is exactly the plain text.
 */
export interface Style {
  /** A run state, coloured by meaning. `text` defaults to the state name. */
  state(state: RunState, text?: string): string;
  /** An agent result such as `ok` or `error`. Unknown statuses stay plain. */
  agent(status: string, text?: string): string;
  /** A check result (`passed` / `FAILED`). */
  check(passed: boolean, text: string): string;
  /** Secondary detail: timestamps, ids, costs, durations, paths. */
  detail(text: string): string;
  /** Something that needs a person's attention, such as a gate a run waits at. */
  attention(text: string): string;
  /** A state transition line (`-> build: ...`). */
  transition(text: string): string;
  /** What to do next, such as the approve/reject commands for a waiting run. */
  hint(text: string): string;
}

type Format = Parameters<typeof styleText>[0];

const GOOD: Format = "green";
const WAITING: Format = "yellow";
const BAD: Format = "red";
const ACTIVE: Format = "cyan";
const QUIET: Format = "dim";

/** Every run state has an entry, so a new state cannot go unstyled without a compile error. */
export const STATE_FORMAT: Record<RunState, Format> = {
  intake: ACTIVE,
  triage: ACTIVE,
  refine: ACTIVE,
  critic: ACTIVE,
  build: ACTIVE,
  gate: ACTIVE,
  review: ACTIVE,
  capture: ACTIVE,
  pr: ACTIVE,
  merge: ACTIVE,
  learn: ACTIVE,
  needs_info: WAITING,
  needs_human: WAITING,
  done: GOOD,
  rejected: BAD,
  failed: BAD,
  cancelled: QUIET,
};

export const AGENT_FORMAT: Record<AgentRunStatus, Format> = {
  running: ACTIVE,
  ok: GOOD,
  error: BAD,
  rate_limited: WAITING,
  cancelled: QUIET,
};

export function createStyle(enabled: boolean): Style {
  // Empty text stays empty, so padding and trimming around a styled cell work as on plain text.
  // validateStream is off because colourEnabled already decided; that also makes Node versions
  // before 22.13 (which ignore the option and always colour) behave the same.
  const paint = (format: Format | undefined, text: string): string =>
    enabled && format && text ? styleText(format, text, { validateStream: false }) : text;
  return {
    state: (state, text = state) => paint(STATE_FORMAT[state], text),
    agent: (status, text = status) => paint(AGENT_FORMAT[status as AgentRunStatus], text),
    check: (passed, text) => paint(passed ? GOOD : BAD, text),
    detail: (text) => paint(QUIET, text),
    attention: (text) => paint(WAITING, text),
    transition: (text) => paint("bold", text),
    hint: (text) => paint("bold", text),
  };
}

/** No styling at all: the default for commands, so tests and library callers get plain text. */
export const plain: Style = createStyle(false);

/**
 * Whether to colour output written to `stream`, following Node's own rules: `FORCE_COLOR` wins
 * (`0`/`false` or an unknown value turns colour off), then `NO_COLOR`, `NODE_DISABLE_COLORS` and
 * `TERM=dumb` turn it off, and otherwise only a TTY gets colour (not a pipe or a file).
 */
export function colourEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FORCE_COLOR !== undefined) return ["", "1", "true", "2", "3"].includes(env.FORCE_COLOR);
  if (env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined || env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

/** The style for output written to `stream` (stdout by default). */
export function styleFor(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): Style {
  return createStyle(colourEnabled(stream, env));
}
