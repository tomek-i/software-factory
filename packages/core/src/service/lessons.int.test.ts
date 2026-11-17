import { describe, expect, it, vi } from "vitest";
import { LESSON, setup } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT } from "../../test/helpers.js";
import { loadConfig } from "../config/load.js";
import type { GithubPort } from "../github/port.js";
import { ServiceError } from "./errors.js";
import { approveLessons, listLessons, proposedLessons, rejectLessons } from "./lessons.js";
import type { ServiceContext } from "./runs.js";

// Each test drives a real git repo; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

/** A repo with one run for #12 and the learner's proposals from it. */
function context(...rules: string[]) {
  const s = setup([]);
  const ctx: ServiceContext = { store: s.store, project: s.project, config: loadConfig(s.root) };
  const run = s.store.createRun({ project_id: s.project.id, title: "Add the feature", issue_number: 12 });
  const ids = s.store.addLessons(run.id, rules.map((rule) => ({ ...LESSON, rule }))).map((l) => l.id);
  return { ...s, ctx, runId: run.id, ids };
}

describe("lessons", () => {
  it("lists the proposed lessons with their run's issue, and every lesson with all", () => {
    const { store, project, ids, runId } = context("Run lint first.", "Use pnpm.");
    rejectLessons(store, project, [ids[1]!], "  already in the README ");

    expect(listLessons(store, project)).toEqual([expect.objectContaining({ id: ids[0], run_id: runId, issue_number: 12, status: "proposed" })]);
    expect(listLessons(store, project, { all: true }).map((l) => [l.id, l.status, l.comment])).toEqual(
      expect.arrayContaining([
        [ids[0], "proposed", null],
        [ids[1], "rejected", "already in the README"],
      ]),
    );
  });

  it("approves lessons on one lessons PR and records it", () => {
    const { ctx, store, ids, readyPrs, github } = context("Run lint first.", "Use pnpm.");

    const published = approveLessons(ctx, ids, { github, now: new Date("2026-11-12T09:05:07Z") });

    expect(published).toMatchObject({ number: 8, addedToOpen: false });
    expect(readyPrs).toHaveLength(1);
    expect(ids.map((id) => store.getLesson(id))).toEqual(ids.map(() => expect.objectContaining({ status: "approved", pull_request: 8 })));
  });

  it("names every lesson it cannot decide, and approves nothing when publishing fails", () => {
    const { ctx, store, project, ids, github } = context("Run lint first.");
    rejectLessons(store, project, ids);
    expect(() => proposedLessons(store, project, [...ids, 99])).toThrow(
      new ServiceError(`Lesson ${ids[0]} is already rejected.\nNo lesson 99.\nSee \`factory lessons --all\`.`),
    );

    const [fresh] = store.addLessons(store.listRuns({})[0]!.id, [{ ...LESSON, rule: "Another." }]).map((l) => l.id);
    const down: GithubPort = {
      ...github,
      createPullRequest: () => {
        throw new Error("GitHub is down");
      },
    };
    expect(() => approveLessons(ctx, [fresh!], { github: down })).toThrow(/^Could not publish the lessons; nothing was approved: .*GitHub is down/);
    expect(store.getLesson(fresh!)!.status).toBe("proposed");
  });
});
