import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, CODE_PASS, LESSON, learned, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import type { CapturePort } from "../capture/capture.js";
import { approveTarget, REFINE_MARKER, runDirOf, waitingCommit } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

/**
 * One run through every stage with the default gates (only the merge waits for a human): the
 * stage tests each cover one part, this shows the parts fit together end to end.
 */
describe("PipelineDriver: the whole pipeline", () => {
  const config =
    "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\n" +
    "gates:\n  triage: auto\n  critic: auto\n  review: auto\n  pr: always\n  merge: human\n" +
    'reviews:\n  always: [code]\n  ui: []\napp:\n  start: "node app.js"\n';
  const triage = TRIAGE().replace("READINESS: READY", "READINESS: INCOMPLETE").replace("SURFACES: api", "SURFACES: ui, api");
  const refine: FakeStep = {
    role: "refine",
    output:
      "STATUS: REFINED\n\n## Summary\n- spec\n\n## Acceptance criteria\n- [ ] feature.txt says fixed\n\n## Scope\n- add feature.txt\n\n## Out of scope\n- anything else\n\n## Open questions\n- Which encoding? Assumed UTF-8\n",
  };
  const critic: FakeStep = { role: "critic", output: "VERDICT: ACCEPT\n\n## Summary\n- holds\n\n## Notes\n- keep it to one line\n" };
  const plan: FakeStep = {
    role: "capture",
    output: [
      "CAPTURE: PLAN",
      "",
      "## Summary",
      "- the feature page",
      "",
      "## Plan",
      "```json",
      JSON.stringify({ pages: [{ name: "feature", path: "/feature", screen: "new" }], walkthrough: [{ action: "goto", path: "/feature" }] }),
      "```",
      "",
    ].join("\n"),
  };

  /** Stands in for the browser: writes the media the real port would, and "uploads" it. */
  const capture: CapturePort = {
    capture: async (request) => {
      const file = (name: string) => {
        const path = join(request.outDir, name);
        writeFileSync(path, "media");
        return path;
      };
      return {
        status: "captured",
        pages: [{ name: "feature", path: "/feature", screen: "new", after: [{ width: 1440, file: file("after-feature-1440.png"), signals: [] }] }],
        walkthrough: { video: file("walkthrough.webm"), screenshots: [], ran: 1, signals: [] },
        notes: ["no before shot of feature (/feature): it is a new screen"],
      };
    },
    publish: (runId, files) => Object.fromEntries(files.map((f) => [basename(f), `https://github.com/o/r/releases/download/factory-media-${runId}/${basename(f)}`])),
  };

  it("takes an incomplete UI issue from triage through refine, critic, build, gate, review, capture, PR and merge to learn", async () => {
    // The first build fails the quality gate, so the run has something to learn from.
    const steps = [{ output: triage }, refine, critic, buildStep("broken"), buildStep("fixed"), CODE_PASS, plan, { role: "learner", output: learned([LESSON]) }];
    const { driver, store, project, root, fake, comments, edits, pr, merges } = setup(steps, { config, capture });
    const run = driver.startRun(12);

    // Everything up to the merge runs by itself; the merge gate waits for a human by default.
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    const head = waitingCommit(store.listEvents(run.id))!;
    const parked = store.getRun(run.id)!;
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, approveTarget(parked, "build")!, { comment: "ship it", commitSha: head });

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });

    const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
    expect(moves).toEqual([
      "->intake",
      "intake>triage",
      "triage>refine",
      "refine>critic",
      "critic>build",
      "build>gate",
      "gate>build",
      "build>gate",
      "gate>review",
      "review>capture",
      "capture>pr",
      "pr>merge",
      "merge>needs_human",
      "needs_human>merge",
      "merge>learn",
      "learn>done",
    ]);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "critic", "builder", "builder", "reviewer-code", "capture", "learner"]);

    // Refine posted the spec on the issue; the PR shows the screenshots; exactly the approved commit merged.
    expect(comments.filter((c) => c.body.startsWith(REFINE_MARKER))).toHaveLength(1);
    expect(edits.at(-1)!.body).toContain("## Screenshots");
    expect(pr.draft).toBe(false);
    expect(merges).toEqual([{ number: 7, head }]);
    expect(store.listDecisions(run.id).map((d) => `${d.gate}:${d.outcome}`)).toEqual(
      expect.arrayContaining(["triage:proceed", "critic:proceed", "review:proceed", "pr:proceed", "merge:approve"]),
    );

    // The learner's lesson waits for approval; nothing reached lessons.md.
    expect(store.listLessons({ project_id: project.id, status: "proposed" }).map((l) => l.rule)).toEqual([LESSON.rule]);
    const dir = runDirOf(root, run.id);
    for (const file of ["triage.md", "spec-1/refine.md", "spec-1/critic.md", "build.md", "round-2/checks.md", "round-2/review-code.md", "round-2/capture-report.md", "learn.md"])
      expect(existsSync(join(dir, file)), file).toBe(true);
  });
});
