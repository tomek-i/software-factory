import { describe, expect, it } from "vitest";
import { setup } from "../../test/driver-setup.js";
import { loadConfig } from "../config/load.js";
import type { GithubPort } from "../github/port.js";
import { cleanUpNow, reconcileAndSweep, reconcileRuns, reportLines, sweepFinishedRuns } from "./reconcile.js";

function context() {
  const s = setup([]);
  const config = loadConfig(s.root);
  // A run whose draft PR #7 is open on the fake GitHub until a test says otherwise.
  const run = s.store.createRun({ project_id: s.project.id, title: "Add the feature", issue_number: 12 });
  s.store.writeState(run.id, "review", { pr_number: 7 });
  return { ...s, config, runId: run.id };
}

describe("reconcileAndSweep", () => {
  it("finishes a run whose PR was closed on GitHub, and reports it with its cleanup", () => {
    const { store, project, config, github, pr, runId } = context();
    expect(reconcileAndSweep(store, project, config, { github })).toEqual({ moved: [], reconciled: [], cleaned: [], swept: [] });

    pr.state = "closed";
    const report = reconcileAndSweep(store, project, config, { github });

    expect(report.moved).toEqual([runId]);
    expect(report.reconciled).toEqual([`${runId}: PR #7 closed -> cancelled`]);
    expect(reportLines(report)).toEqual([...report.reconciled, ...report.cleaned, ...report.swept]);
    expect(store.getRun(runId)!.state).toBe("cancelled");
  });
});

describe("reconcileRuns", () => {
  it("warns instead of throwing when GitHub cannot be asked, and skips a project without a GitHub repository", () => {
    const { store, project, config, github, runId } = context();
    const down: GithubPort = {
      ...github,
      pullRequestState: () => {
        throw new Error("offline");
      },
    };
    expect(reconcileRuns(store, project, config, { github: down })).toEqual([`warning: could not check PR #7 of ${runId}: offline`]);
    expect(reconcileRuns(store, { ...project, github_repo: null }, config, {})).toEqual([]);
  });
});

describe("sweepFinishedRuns and cleanUpNow", () => {
  it("say nothing when there is nothing to clean up, and warn instead of throwing", () => {
    const { store, project, config, runId } = context();
    expect(sweepFinishedRuns(store, project, config, {})).toEqual([]);
    expect(cleanUpNow(store, project, config, "no-such-run")).toEqual([]);

    const broken: typeof store = Object.assign(Object.create(store), {
      listRuns: () => {
        throw new Error("db is gone\nstack");
      },
    });
    expect(sweepFinishedRuns(broken, project, config, {})).toEqual(["warning: could not clean up finished runs: db is gone"]);
    expect(store.getRun(runId)!.state).toBe("review");
  });
});
