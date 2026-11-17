import { factoryConfigSchema } from "@factory/shared";
import type { CapturePort } from "../src/capture/capture.js";
import type { GithubPort } from "../src/github/port.js";
import { StageContext, type DriverDeps } from "../src/pipeline/stages/context.js";
import { Store, type Run } from "../src/store/store.js";
import { tempDir } from "./helpers.js";

/**
 * One stage over an in-memory store and a temp project folder, for unit tests of a stage's
 * decisions: no git, no agent, no GitHub unless a test hands in what it needs. The run is #12's,
 * leased to the test as the driver would hold it. A stage path that reaches git, an agent or
 * GitHub belongs in a driver.*.int.test.ts.
 */
export function stageSetup(config: Record<string, unknown> = {}, deps: Partial<DriverDeps> = {}) {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: tempDir(), github_repo: "o/r" });
  store.upsertIssue(project.id, { number: 12, title: "Add the feature", body: "", state: "open", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
  const parsed = factoryConfigSchema.parse({ version: 1, trust: { authors: ["alice"] }, ...config });
  const all = { store, project, config: parsed, read: () => undefined, github: {} as GithubPort, capture: {} as CapturePort, owner: "test", ...deps } as unknown as DriverDeps;
  const ctx = new StageContext(all, () => undefined);
  const run = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });
  store.acquireLease(run.id, "test", 60_000);
  /** Put the run in `state` (and `round`), as the stage before it would have left it. */
  const at = (state: Run["state"], round = 1): Run => {
    store.writeState(run.id, state, { round });
    return store.getRun(run.id)!;
  };
  const lastMove = () => store.listEvents(run.id).at(-1)!;
  return { store, project, ctx, run, at, lastMove };
}
