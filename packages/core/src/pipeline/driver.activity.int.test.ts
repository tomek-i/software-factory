import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";

describe("PipelineDriver agent activity", () => {
  it("shows the paths agents touch relative to their folder, not as local absolute paths", async () => {
    const { driver, seen, root } = setup([
      { output: TRIAGE(), stream: "write_in_cwd" },
      { ...buildStep("fixed"), stream: "write_in_cwd" },
    ]);
    const run = driver.startRun(12);

    await driver.drive(run.id);

    const activity = seen.flatMap((e) => (e.type === "agent:activity" ? [e.summary] : []));
    // Triage runs in the repo, the builder in its worktree under .worktrees/: both show `src/feature.ts`.
    expect(activity.filter((a) => a === "Write: src/feature.ts")).toHaveLength(2);
    // The builder's run folder (its --add-dir) is outside its worktree, so it is shown from the repo root.
    expect(activity).toContain(`Write: ${join(".factory", "runs", run.id)}/notes.md`);
    expect(activity.join("\n")).not.toContain(root);
  });
});
