import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { bumpy, buildStep, CODE_PASS, lastMove, learnConfig as config, learned, LESSON, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, type FakeStep } from "../../test/helpers.js";
import { approveTarget, runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

describe("PipelineDriver learn stage", () => {
  it("asks the learner about a bumpy run and stores its lessons as proposals, without touching lessons.md", async () => {
    const { driver, store, fake, root } = setup(bumpy({ output: learned([LESSON]) }), { config: config() });
    const mainBefore = git(root, "rev-parse", "origin/main");
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(lastMove(store, run.id)).toMatchObject({ from_state: "learn", to_state: "done", reason: "1 lesson proposed; see `factory lessons`", data: { lessons: 1 } });
    expect(store.listLessons({ project_id: run.project_id })).toMatchObject([{ run_id: run.id, status: "proposed", ...LESSON }]);

    const dir = runDirOf(root, run.id);
    const learner = fake.calls().find((c) => c.role === "learner")!;
    expect(learner.stdin).toContain(`Output file: \`${join(dir, "learn.md")}\``);
    expect(learner.stdin).toContain("## Why this run is worth a look\n- it took 2 rounds\n- the quality gate failed (round-1/checks.md)");
    expect(learner.stdin).toContain("- gate -> build: quality gate failed (round 1)");
    expect(learner.stdin).toContain("Human decisions:\n(none)");
    expect(learner.stdin).toContain(`- \`${join(dir, "round-1", "checks.md")}\``);
    expect(learner.stdin).toContain(`- \`${join(dir, "round-2", "review-code.md")}\``);
    // Read-only: no shell, and learn.md is the only file it may write.
    const settings = JSON.parse(readFileSync(join(dir, "agent", "learner.settings.json"), "utf8")) as { permissions: { allow: string[]; deny: string[] } };
    expect(settings.permissions.deny).toContain("Bash");
    expect(settings.permissions.allow.filter((rule) => rule.startsWith("Edit") || rule.startsWith("Write"))).toEqual([expect.stringMatching(/learn\.md\)$/)]);
    expect(readFileSync(join(dir, "agent", "learner.md"), "utf8")).toContain("# Role: learner");
    // Nothing reaches the default branch without a human's approval.
    git(root, "fetch", "-q", "origin");
    expect(git(root, "rev-parse", "origin/main")).toBe(mainBefore);
  });

  it("shows the learner where a human sent the run back, with their comment", async () => {
    const reviewHuman = config().replace("  merge: always\n", "  merge: always\n  review: human\n");
    const rework: FakeStep = {
      files: { "feature.txt": "fixed\n", "notes.txt": "constant\n" },
      exec: [
        ["git", "add", "-A"],
        ["git", "commit", "-qm", "refactor: use a constant"],
      ],
      output: "STATUS: READY\nCOMMIT: {{HEAD}}\nTITLE: feat: add the feature\n\n## Summary\n- reworked\n",
    };
    const steps = [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, rework, CODE_PASS, { role: "learner", output: learned([]) }];
    const { driver, store, fake } = setup(steps, { config: reviewHuman });
    const run = driver.startRun(12);
    const machine = new RunMachine(store, factoryConfigSchema.parse({ version: 1 }));

    await driver.drive(run.id);
    machine.resume(run.id, "build", { comment: "use a named constant" });
    await driver.drive(run.id);
    machine.resume(run.id, approveTarget(store.getRun(run.id)!, "build")!, { comment: "fine now" });

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    const learner = fake.calls().find((c) => c.role === "learner")!;
    expect(learner.stdin).toContain("- a human sent the run to build: use a named constant");
    expect(learner.stdin).toContain("Human decisions:\n- at the review gate, sent the run to build: use a named constant\n- at the review gate, sent the run to capture: fine now");
  });

});
