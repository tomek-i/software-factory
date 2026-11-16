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

  describe("paths in tool calls", () => {
    const repo = "C:\\Users\\al\\code\\app";
    const worktree = `${repo}\\.worktrees\\67-restructure-the-cli-commands`;
    const tool = (name: string, input: Record<string, string>, roots?: string[]) =>
      applyStreamLine(emptySummary(), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } }), roots);

    it("shows a path in the agent's worktree relative to it, and one elsewhere in the repo relative to the repo", () => {
      expect(tool("Write", { file_path: `${worktree}\\src\\a.ts` }, [repo, worktree])).toEqual(["Write: src\\a.ts"]);
      expect(tool("Write", { file_path: `${repo}\\.factory\\runs\\67\\triage.md` }, [repo, worktree])).toEqual(["Write: .factory\\runs\\67\\triage.md"]);
    });

    it("shortens paths inside a command too", () => {
      expect(tool("Bash", { command: `cd ${worktree} && pnpm test` }, [repo, worktree])).toEqual(["Bash: cd . && pnpm test"]);
    });

    it("keeps a deep file's name, shortening before the line is cut", () => {
      const deep = `${worktree}\\${"nested\\".repeat(12)}file.ts`;
      const [line] = tool("Read", { file_path: deep }, [repo, worktree]);
      expect(line).toMatch(/^Read: nested\\/);
      expect(line).toMatch(/file\.ts$/);
    });

    it("leaves search patterns alone: they are regexes and globs, not paths", () => {
      expect(tool("Grep", { pattern: "C:\\\\Users\\\\al" }, [repo])).toEqual(["Grep: C:\\\\Users\\\\al"]);
      expect(tool("Glob", { pattern: "/home/al/**" }, [repo])).toEqual(["Glob: /home/al/**"]);
    });

    it("shows a user profile outside the roots as ~", () => {
      expect(tool("Read", { file_path: "C:\\Users\\al\\notes.md" })).toEqual(["Read: ~\\notes.md"]);
    });
  });
});
