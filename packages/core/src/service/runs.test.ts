import { factoryConfigSchema } from "@factory/shared";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { Store } from "../store/store.js";
import { ServiceError } from "./errors.js";
import { cleanupRunNow } from "./runs.js";

/** A project in a plain folder with one run for #12; no git is reached on these paths. */
function setup() {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: tempDir(), github_repo: "o/r" });
  const run = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });
  return { ctx: { store, project, config: factoryConfigSchema.parse({ version: 1 }) }, store, run };
}

describe("cleanupRunNow", () => {
  it("refuses a run that has not finished", () => {
    const { ctx, store, run } = setup();
    store.writeState(run.id, "review");
    expect(() => cleanupRunNow(ctx, run.id)).toThrow(new ServiceError(`Run ${run.id} has not finished (it is review); cancel it first.`));
  });

  it("refuses a finished run a worker still holds, and leaves it to that worker", () => {
    const { ctx, store, run } = setup();
    store.writeState(run.id, "cancelled");
    store.acquireLease(run.id, "worker", 60_000);
    expect(() => cleanupRunNow(ctx, run.id)).toThrow(new ServiceError(`A worker still holds run ${run.id}; it cleans up once it has stopped.`));
  });

  it("says so when a finished run has nothing left to clean up", () => {
    const { ctx, store, run } = setup();
    store.writeState(run.id, "done");
    expect(cleanupRunNow(ctx, run.id)).toEqual([`${run.id}: nothing left to clean up`]);
  });
});
