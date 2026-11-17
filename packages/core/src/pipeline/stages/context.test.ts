import { factoryConfigSchema } from "@factory/shared";
import { describe, expect, it } from "vitest";
import type { CapturePort } from "../../capture/capture.js";
import type { Run } from "../../store/store.js";
import type { CommandRunner } from "../../util/exec.js";
import { StageContext, type DriverDeps } from "./context.js";

function context(current: () => AbortSignal | undefined, extra: Partial<DriverDeps> = {}): StageContext {
  const deps = {
    config: factoryConfigSchema.parse({ version: 1 }),
    project: { id: 1, repo_path: "/repo" },
    store: {},
    capture: {} as CapturePort,
    ...extra,
  } as unknown as DriverDeps;
  return new StageContext(deps, current);
}

describe("StageContext", () => {
  it("reads the driver's abort signal when a stage uses it, not when the context is built", () => {
    let signal: AbortSignal | undefined;
    const ctx = context(() => signal);
    expect(ctx.signal).toBeUndefined();

    signal = new AbortController().signal;
    expect(ctx.signal).toBe(signal);
    expect(ctx.agentBase({ id: "r1" } as Run, "triage", "/repo").signal).toBe(signal);

    signal = undefined;
    expect(ctx.signal).toBeUndefined();
  });

  it("reads a file from the default branch once per step, and again in the next step", () => {
    const onMain: Record<string, string> = { ".factory/lessons.md": "- one\n" };
    const reads: string[] = [];
    const ctx = context(() => undefined, { read: (path) => (reads.push(path), onMain[path]) });

    ctx.startStep();
    expect(ctx.deps.read(".factory/lessons.md")).toBe("- one\n");
    expect(ctx.deps.read(".factory/lessons.md")).toBe("- one\n");
    expect(ctx.deps.read(".factory/prompts/triage.md")).toBeUndefined();
    expect(ctx.deps.read(".factory/prompts/triage.md")).toBeUndefined();
    expect(reads).toEqual([".factory/lessons.md", ".factory/prompts/triage.md"]);

    onMain[".factory/lessons.md"] = "- two\n";
    ctx.startStep();
    expect(ctx.deps.read(".factory/lessons.md")).toBe("- two\n");
  });

  it("finds where a commit left the default branch once per step and commit", () => {
    const calls: string[] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args[1] === "fetch" ? "fetch" : `merge-base ${args.at(-1)}`);
      return { code: 0, stdout: args[1] === "merge-base" ? `base-of-${args.at(-1)}` : "", stderr: "" };
    };
    const ctx = context(() => undefined, { run });
    const worktree = { path: "/repo/.worktrees/r1", branch: "factory/1-x" };

    ctx.startStep();
    expect(ctx.freshBase(worktree, "aaa")).toBe("base-of-aaa");
    expect(ctx.freshBase(worktree, "aaa")).toBe("base-of-aaa");
    expect(ctx.freshBase(worktree, "bbb")).toBe("base-of-bbb");
    expect(calls).toEqual(["fetch", "merge-base aaa", "fetch", "merge-base bbb"]);

    ctx.startStep();
    ctx.freshBase(worktree, "aaa");
    expect(calls).toHaveLength(6);
  });
});
