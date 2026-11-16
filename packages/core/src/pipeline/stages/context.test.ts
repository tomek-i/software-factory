import { factoryConfigSchema } from "@factory/shared";
import { describe, expect, it } from "vitest";
import type { CapturePort } from "../../capture/capture.js";
import type { Run } from "../../store/store.js";
import { StageContext, type DriverDeps } from "./context.js";

function context(current: () => AbortSignal | undefined): StageContext {
  const deps = {
    config: factoryConfigSchema.parse({ version: 1 }),
    project: { id: 1, repo_path: "/repo" },
    store: {},
    capture: {} as CapturePort,
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
});
