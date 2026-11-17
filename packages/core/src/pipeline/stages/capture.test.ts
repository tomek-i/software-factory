import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { UI_TRIAGE } from "../../../test/capture-setup.js";
import { TRIAGE } from "../../../test/driver-setup.js";
import { stageSetup } from "../../../test/stage-setup.js";
import type { AgentRunner } from "../../agents/runner.js";
import type { CapturePort } from "../../capture/capture.js";
import { capture } from "./capture.js";

/** The capture stage for a run whose triage wrote `triage`, with `app` as the config's app section. */
function capturing(triage: string, app: Record<string, unknown>) {
  const runAgent = vi.fn<AgentRunner>();
  const port = { capture: vi.fn() } as unknown as CapturePort;
  const setup = stageSetup({ app }, { runAgent, capture: port });
  const dir = setup.ctx.runDir(setup.run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "triage.md"), triage);
  const infos = vi.spyOn(setup.ctx, "info");
  return { ...setup, runAgent, port, infos };
}

describe("capture stage", () => {
  it("skips capture without an agent when triage did not list ui, or no app.start is configured", async () => {
    for (const [triage, app, why] of [
      [TRIAGE(), { start: "node app.js" }, "triage did not list ui in SURFACES"],
      [UI_TRIAGE, {}, "app.start is not configured"],
    ] as const) {
      const { ctx, at, lastMove, runAgent, port, infos } = capturing(triage, app);

      await capture(ctx, at("capture"));

      expect(lastMove()).toMatchObject({ from_state: "capture", to_state: "pr", reason: `capture skipped: ${why}` });
      expect(infos).toHaveBeenCalledWith(expect.anything(), `capture skipped: ${why}`);
      expect(runAgent).not.toHaveBeenCalled();
      expect(port.capture).not.toHaveBeenCalled();
    }
  });
});
