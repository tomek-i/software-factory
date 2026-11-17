import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "@factory/shared";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { renderChecks } from "../gate/gate.js";
import { runDirOf } from "../pipeline/shared.js";
import { Store } from "../store/store.js";
import { parkingEvent, waitingOn } from "./waiting.js";

const HEAD = "a".repeat(40);

function parkedRun(from: RunState, reason: string, data?: unknown, round = 2) {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: tempDir() });
  const run = store.createRun({ project_id: project.id, title: "t", issue_number: 1 });
  store.writeState(run.id, "needs_human", { parked_from: from, round });
  store.appendEvent(run.id, from, "needs_human", reason, data);
  const dir = runDirOf(project.repo_path, run.id);
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  return { store, project, run: store.getRun(run.id)!, write };
}

const failedGate = renderChecks({
  passed: false,
  head: HEAD,
  checks: [
    { name: "lint", command: "pnpm lint", passed: true, exitCode: 0, timedOut: false, durationMs: 1000, tail: "", attempts: 1 },
    { name: "test", command: "pnpm test", passed: false, exitCode: 1, timedOut: false, durationMs: 2000, tail: "1 failed", attempts: 1 },
  ],
  secrets: { tool: "regex", hits: [] },
});

describe("waitingOn", () => {
  it("says a run's issue was closed on GitHub while its PR is open, and nothing while the issue is open", () => {
    const { store, project, run } = parkedRun("merge", "waiting at merge gate: gate is set to human");
    store.upsertIssue(project.id, { number: 1, title: "t", body: "", state: "open", author: "a", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
    store.writeState(run.id, "needs_human", { pr_number: 7, waiting_gate: "merge" });
    expect(waitingOn(store, project, store.getRun(run.id)!).issueClosed).toBeUndefined();

    store.closeIssue(project.id, 1);
    expect(waitingOn(store, project, store.getRun(run.id)!)).toEqual({ issueClosed: { pr: 7 } });
    // Without a PR, reconcile cancels the run rather than ask.
    store.writeState(run.id, "needs_human", { pr_number: null });
    expect(waitingOn(store, project, store.getRun(run.id)!).issueClosed).toBeUndefined();
  });

  it("names the loop cap that stopped a run", () => {
    const { store, project, run } = parkedRun("gate", "quality gate still failing after round 2: build iteration cap reached (5)");
    expect(waitingOn(store, project, run).capReached).toBe("build iteration cap reached (5)");
    const review = parkedRun("review", "waiting at review gate: reviews: code CHANGES; reviews still have confirmed findings after round 3: review round cap reached (3)");
    expect(waitingOn(review.store, review.project, review.run).capReached).toBe("review round cap reached (3)");
    const agent = parkedRun("build", "builder is blocked: pricing");
    expect(waitingOn(agent.store, agent.project, agent.run)).toEqual({});
  });

  it("gives the failed required checks of the merge stage", () => {
    const { store, project, run } = parkedRun("merge", "required check failed on PR #7: CodeQL (https://ci/1)", {
      failedChecks: [{ name: "CodeQL", link: "https://ci/1" }, { name: "test" }],
    });
    expect(waitingOn(store, project, run).failure).toEqual({ kind: "checks", items: [{ name: "CodeQL", link: "https://ci/1" }, { name: "test" }] });
  });

  it("gives the checks that failed the quality gate, from the round's checks.md or the merge stage's re-run", () => {
    const gate = parkedRun("gate", "quality gate still failing after round 2: build iteration cap reached (5)");
    gate.write("round-2/checks.md", failedGate);
    expect(waitingOn(gate.store, gate.project, gate.run).failure).toEqual({
      kind: "quality_gate",
      items: [{ name: "test", summary: "FAILED (exit 1) in 2.0s" }],
      source: "round-2/checks.md",
    });

    const merge = parkedRun("merge", "still cannot merge after round 2: review round cap reached (3)");
    expect(waitingOn(merge.store, merge.project, merge.run).failure).toBeUndefined();
    merge.write("round-2/resync/checks.md", failedGate);
    expect(waitingOn(merge.store, merge.project, merge.run).failure).toMatchObject({ kind: "quality_gate", source: "round-2/resync/checks.md" });

    // A pass, or a round other than the run's, says nothing about why it waits.
    const passed = parkedRun("gate", "quality gate passed but the checked commit is not pushed");
    passed.write("round-2/checks.md", failedGate.replace("GATE: FAIL", "GATE: PASS"));
    passed.write("round-1/checks.md", failedGate);
    expect(waitingOn(passed.store, passed.project, passed.run).failure).toBeUndefined();
  });

  it("gives the findings the verifier confirmed", () => {
    const { store, project, run, write } = parkedRun("review", "waiting at review gate: review round cap reached (3)");
    write(
      "round-2/verify.md",
      'VERDICT: CONFIRMED\n\n## Summary\n- real\n\n## Findings\n```json\n[{"id":"code-1","severity":"major","file":"src/a.ts","line":12,"claim":"the limiter is skipped","evidence":"line 12"}]\n```\n',
    );
    expect(waitingOn(store, project, run).failure).toEqual({
      kind: "findings",
      items: [{ name: "code-1 (major)", summary: "the limiter is skipped", file: "src/a.ts", line: 12 }],
      source: "round-2/verify.md",
    });
  });

  it("gives the open review threads and failed optional checks the merge gate waits on, as one plain line each", () => {
    const { store, project, run } = parkedRun("merge", "waiting at merge gate: unresolved review thread by bob", {
      commit: HEAD,
      openFeedback: {
        threads: [
          { id: "T1", author: "bob", path: "src/a.ts", line: 3, url: "https://github.com/o/r/pull/7#discussion_r1", excerpt: "rename \u001b[31mthis\u001b[0m" },
          { id: "T2", author: "carol", url: "https://github.com/o/r/pull/7#discussion_r2", excerpt: "" },
        ],
        checks: [
          { name: "CodeQL", bucket: "fail", summary: "2 new alerts", link: "https://github.com/o/r/runs/3" },
          { name: "e2e", bucket: "cancel" },
        ],
      },
    });
    expect(waitingOn(store, project, run).failure).toEqual({
      kind: "feedback",
      source: "round-2/resync/feedback.md",
      items: [
        { name: "review thread by bob", summary: "rename [31mthis [0m", file: "src/a.ts", line: 3, link: "https://github.com/o/r/pull/7#discussion_r1" },
        { name: "review thread by carol", link: "https://github.com/o/r/pull/7#discussion_r2" },
        { name: "CodeQL", summary: "failed: 2 new alerts", link: "https://github.com/o/r/runs/3" },
        { name: "e2e", summary: "cancelled" },
      ],
    });
  });

  it("looks only at a run waiting for a human, and at the move that parked it", () => {
    const { store, project, run } = parkedRun("gate", "build iteration cap reached (5)");
    // A later note on the parked run (e.g. a dismissal) is not what parked it.
    store.appendEvent(run.id, "needs_human", "needs_human", "noted");
    expect(parkingEvent(store.listEvents(run.id))?.reason).toBe("build iteration cap reached (5)");
    store.writeState(run.id, "build");
    expect(waitingOn(store, project, store.getRun(run.id)!)).toEqual({});
  });
});
