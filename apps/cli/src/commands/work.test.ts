import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema, isTerminal } from "@factory/shared";
import { findRepoRoot, readStopRequest, Store, type DriveFn, type DriveOutcome, type ProjectContext, type StopRequest } from "@factory/core";
import { CliError } from "../context.js";
import { parseMaxRuns, refuseRunningOnAnyProject, runStop, runWork, type WorkDeps } from "./work.js";

/** One project with queued issues, and a drive that ends each run with the next scripted outcome. */
function setup(outcomes: DriveOutcome[], issues = [12]) {
  const store = new Store(":memory:");
  const row = store.upsertProject({ name: "shop", repo_path: "/repos/shop", github_repo: "acme/shop" });
  for (const number of issues) {
    store.upsertIssue(row.id, { number, title: `Add thing ${number}`, body: "", state: "open", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
    store.setQueued(row.id, number, true);
  }
  const ctx: ProjectContext = { root: row.repo_path, config: factoryConfigSchema.parse({ version: 1 }), store, project: row };
  const lines: string[] = [];
  let stop: StopRequest | undefined;
  const drive: DriveFn = async (c, number, _options, deps) => {
    const existing = c.store.listRuns({ project_id: row.id }).find((r) => r.issue_number === number && !isTerminal(r.state));
    const run = existing ?? c.store.createRun({ project_id: row.id, title: `Add thing ${number}`, issue_number: number });
    deps.events?.emit({ type: "run:state", runId: run.id, from: "intake", to: "triage", reason: "start triage" });
    deps.onNotice?.({ type: "started", run, issue: c.store.getIssue(row.id, number)!, stop: () => {} });
    const outcome = outcomes.shift() ?? { kind: "finished", state: "done" };
    if (outcome.kind === "parked" || outcome.kind === "finished") c.store.writeState(run.id, outcome.state);
    // Stop once the scripted runs are through, so the worker drains and the test ends.
    if (outcomes.length === 0) stop = { at: Date.now() + 1, now: false };
    return { outcome, run: c.store.getRun(run.id)! };
  };
  const deps: WorkDeps = {
    print: (line) => lines.push(line),
    projects: () => [{ path: row.repo_path, name: "shop", added_at: "t" }],
    reconcile: () => ["finished run abc: its PR was merged"],
    scheduler: {
      open: () => ctx,
      trustedConfig: () => factoryConfigSchema.parse({ version: 1 }),
      fetchIssue: () => {},
      drive,
      stopRequest: () => stop,
      tickMs: 5,
    },
  };
  return { deps, lines, store };
}

describe("runWork", () => {
  it("says to register a project when there is none", async () => {
    await expect(runWork({}, { projects: () => [] })).rejects.toThrow(CliError);
  });

  it("prints each run's progress with its project and issue, and stops when asked", async () => {
    const { deps, lines } = setup([{ kind: "finished", state: "done" }]);

    const result = await runWork({ maxRuns: 2 }, deps);

    expect(result).toEqual({ message: "Stopped: no runs are going on.", interrupted: false });
    expect(lines[0]).toBe("[shop] finished run abc: its PR was merged");
    expect(lines).toContain("Working through the queues of 1 project, up to 2 runs at once.");
    expect(lines).toContain("[shop#12] -> triage: start triage");
    expect(lines.some((l) => /^\[shop#12\] Run \S+ \(intake\) for #12 Add thing 12$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[shop#12\] Run \S+ finished: done\.$/.test(l))).toBe(true);
    expect(lines).toContain("Stopping: finishing the runs going on, starting no more.");
  });

  it("says when it pauses for the usage limit", async () => {
    const { deps, lines } = setup([{ kind: "rate_limited", resetsAt: "2099-01-01T00:00:00.000Z" }]);

    await runWork({}, deps);

    expect(lines).toContain("[shop#12] Usage limit reached; the run continues once it resets.");
    expect(lines).toContain("Usage limit reached: starting and continuing nothing until 2099-01-01T00:00:00.000Z.");
  });

  it("obeys a factory stop sent while it was still starting up", async () => {
    const { deps, lines } = setup([{ kind: "finished", state: "done" }, { kind: "finished", state: "done" }], [12, 13]);
    let stop: StopRequest | undefined;
    const reconcile = () => {
      stop = { at: Date.now(), now: false };
      // The scheduler is created a few milliseconds later, as after a slow reconcile.
      const until = Date.now() + 5;
      while (Date.now() < until);
      return [];
    };

    await runWork({}, { ...deps, reconcile, scheduler: { ...deps.scheduler, stopRequest: () => stop } });

    expect(lines.some((l) => l.includes("Run "))).toBe(false);
    expect(lines).toContain("Stopping: finishing the runs going on, starting no more.");
  });

  it("refuses to work on a project that contains this copy of the factory, whenever it was registered", async () => {
    const { deps, lines } = setup([{ kind: "finished", state: "done" }]);
    const here = findRepoRoot(process.cwd())!;

    // Nothing to run, so stop once the refusal has been printed.
    const stopRequest = () => (lines.some((l) => l.includes("Skipped")) ? { at: Date.now() + 1, now: false } : undefined);
    await runWork({}, { ...deps, projects: () => [{ path: here, name: "self", added_at: "t" }], scheduler: { ...deps.scheduler, stopRequest } });

    expect(lines.some((l) => /^\[self\] Skipped: This copy of the factory is inside the repository/.test(l))).toBe(true);
  }, 30_000);

  it("is interrupted when the signal aborts", async () => {
    const { deps } = setup([]);
    const controller = new AbortController();
    controller.abort();

    await expect(runWork({}, { ...deps, signal: controller.signal })).resolves.toMatchObject({ interrupted: true });
  });
});

describe("parseMaxRuns", () => {
  it("takes a whole number of 1 or more", () => {
    expect(parseMaxRuns("4")).toBe(4);
    for (const bad of ["0", "-1", "1.5", "x"]) expect(() => parseMaxRuns(bad)).toThrow(CliError);
  });
});

describe("runStop", () => {
  it("writes a stop request and says what running workers will do", () => {
    const file = join(mkdtempSync(join(tmpdir(), "factory-cli-")), "stop.json");

    expect(runStop({}, file)).toContain("finish the ones going on");
    expect(readStopRequest(file)).toMatchObject({ now: false });
    expect(runStop({ now: true }, file)).toContain("interrupt its runs");
    expect(readStopRequest(file)).toMatchObject({ now: true });
  });
});

describe("refuseRunningOnAnyProject", () => {
  it("refuses when this copy of the factory is inside a registered project, and ignores missing ones", () => {
    const here = findRepoRoot(process.cwd())!;
    expect(() => refuseRunningOnAnyProject(() => [{ path: "/no/such/repo", name: "gone", added_at: "t" }])).not.toThrow();
    expect(() => refuseRunningOnAnyProject(() => [{ path: here, name: "self", added_at: "t" }])).toThrow(/inside the repository it would change/);
  });
});
