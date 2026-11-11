import { styleText } from "node:util";
import { describe, expect, it } from "vitest";
import { RUN_STATES } from "@factory/shared";
import { AGENT_FORMAT, colourEnabled, createStyle, plain, STATE_FORMAT, styleFor } from "./style.js";

const AGENT_STATUSES = ["running", "ok", "error", "rate_limited", "cancelled"] as const;
const paint = (format: Parameters<typeof styleText>[0], text: string) => styleText(format, text, { validateStream: false });
// eslint-disable-next-line no-control-regex -- matching escape characters is the point
const ANSI = /\x1b\[[0-9;]*m/g;

describe("colour scheme", () => {
  it("maps every run state by meaning", () => {
    expect(Object.keys(STATE_FORMAT).sort()).toEqual([...RUN_STATES].sort());
    expect(STATE_FORMAT.done).toBe("green");
    expect([STATE_FORMAT.needs_human, STATE_FORMAT.needs_info]).toEqual(["yellow", "yellow"]);
    expect([STATE_FORMAT.failed, STATE_FORMAT.rejected]).toEqual(["red", "red"]);
    expect(STATE_FORMAT.cancelled).toBe("dim");
    for (const stage of ["intake", "triage", "refine", "critic", "build", "gate", "review", "capture", "pr", "merge", "learn"] as const) {
      expect(STATE_FORMAT[stage]).toBe("cyan");
    }
  });

  it("maps every agent status by meaning", () => {
    expect(Object.keys(AGENT_FORMAT).sort()).toEqual([...AGENT_STATUSES].sort());
    expect(AGENT_FORMAT).toEqual({ running: "cyan", ok: "green", error: "red", rate_limited: "yellow", cancelled: "dim" });
  });

  it("styles text by what it is when colour is on", () => {
    const style = createStyle(true);
    expect(style.state("done")).toBe(paint("green", "done"));
    expect(style.state("needs_human", "waiting at the triage gate")).toBe(paint("yellow", "waiting at the triage gate"));
    expect(style.state("build")).toBe(paint("cyan", "build"));
    expect(style.agent("ok")).toBe(paint("green", "ok"));
    expect(style.agent("error")).toBe(paint("red", "error"));
    expect(style.agent("something-new")).toBe("something-new");
    expect(style.check(true, "passed")).toBe(paint("green", "passed"));
    expect(style.check(false, "FAILED")).toBe(paint("red", "FAILED"));
    expect(style.detail("run-1-a")).toBe(paint("dim", "run-1-a"));
    expect(style.attention("review")).toBe(paint("yellow", "review"));
    expect(style.transition("-> build: go")).toBe(paint("bold", "-> build: go"));
    expect(style.hint("Approve with ...")).toBe(paint("bold", "Approve with ..."));
    // Styling only wraps the text: without the codes it is unchanged.
    expect(style.transition(`-> ${style.state("build")}: go`).replace(ANSI, "")).toBe("-> build: go");
    // Empty text stays empty, so padding and trimming still work.
    expect(style.attention("")).toBe("");
  });

  it("returns the text unchanged when colour is off", () => {
    for (const style of [plain, createStyle(false)]) {
      for (const state of RUN_STATES) expect(style.state(state)).toBe(state);
      for (const status of AGENT_STATUSES) expect(style.agent(status)).toBe(status);
      expect(style.check(false, "FAILED")).toBe("FAILED");
      expect(style.detail("$0.04")).toBe("$0.04");
      expect(style.attention("(untrusted)")).toBe("(untrusted)");
      expect(style.transition("-> build: go")).toBe("-> build: go");
      expect(style.hint("Approve")).toBe("Approve");
    }
  });
});

describe("colourEnabled", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  it("colours a terminal but not a pipe or a file", () => {
    expect(colourEnabled(tty, {})).toBe(true);
    expect(colourEnabled(pipe, {})).toBe(false);
    expect(colourEnabled({}, {})).toBe(false);
  });

  it("respects NO_COLOR, NODE_DISABLE_COLORS and TERM=dumb", () => {
    expect(colourEnabled(tty, { NO_COLOR: "1" })).toBe(false);
    expect(colourEnabled(tty, { NO_COLOR: "" })).toBe(false);
    expect(colourEnabled(tty, { NODE_DISABLE_COLORS: "1" })).toBe(false);
    expect(colourEnabled(tty, { TERM: "dumb" })).toBe(false);
  });

  it("lets FORCE_COLOR turn colour on or off, as Node does", () => {
    for (const value of ["", "1", "true", "2", "3"]) expect(colourEnabled(pipe, { FORCE_COLOR: value })).toBe(true);
    expect(colourEnabled(pipe, { FORCE_COLOR: "1", NO_COLOR: "1" })).toBe(true);
    for (const value of ["0", "false"]) expect(colourEnabled(tty, { FORCE_COLOR: value })).toBe(false);
  });

  it("gives plain output with NO_COLOR or a pipe", () => {
    expect(styleFor(tty, { NO_COLOR: "1" }).state("failed")).toBe("failed");
    expect(styleFor(pipe, {}).state("failed")).toBe("failed");
    expect(styleFor(tty, {}).state("failed")).toContain("\x1b[");
  });
});
