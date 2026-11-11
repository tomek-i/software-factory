import { describe, expect, it } from "vitest";
import { applyStreamLine, emptySummary } from "./stream.js";

describe("applyStreamLine", () => {
  it("ignores lines that are not JSON objects and unknown event types", () => {
    const summary = emptySummary();
    for (const line of ["", "not json", "[1,2]", '{"type":"future_event","x":1}']) applyStreamLine(summary, line);
    expect(summary).toEqual({ activity: [] });
  });

  it("treats a rate-limit retry as a limit even without a rejection event", () => {
    const summary = emptySummary();
    applyStreamLine(summary, '{"type":"system","subtype":"api_retry","error":"rate_limit","session_id":"s"}');
    expect(summary.rateLimit).toEqual({ resetsAt: undefined });
    expect(summary.sessionId).toBe("s");
  });

  it("does not treat an allowed rate-limit status as a limit", () => {
    const summary = emptySummary();
    applyStreamLine(summary, '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1}}');
    expect(summary.rateLimit).toBeUndefined();
  });

  it("describes tool calls briefly", () => {
    const summary = emptySummary();
    const produced = applyStreamLine(
      summary,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "pnpm   test\n--run" } }] },
      }),
    );
    expect(produced).toEqual(["Bash: pnpm test --run"]);
  });
});
