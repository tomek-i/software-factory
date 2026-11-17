import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { landOnMain } from "../../test/merge-setup.js";
import { RunMachine } from "./transitions.js";

/** Files read from the default branch are cached for one step only (see StageContext.startStep). */
describe("PipelineDriver reads from the default branch", () => {
  it("gives a later step the lessons that landed on the default branch since an earlier step read them", async () => {
    const config = "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n  review: human\n";
    const { driver, store, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed")], {
      config,
      files: { ".factory/lessons.md": "- Lesson one.\n" },
    });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    expect(fake.calls()[0]!.stdin).toContain("Lesson one.");

    landOnMain(root, { ".factory/lessons.md": "- Lesson two.\n" });
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "go" });
    await driver.drive(run.id);

    // The same driver, and so the same reader: only the step cache stands between the two reads.
    expect(fake.calls()[1]!.stdin).toContain("Lesson two.");
    expect(fake.calls()[1]!.stdin).not.toContain("Lesson one.");
  });
});
