import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema, isTerminal } from "@factory/shared";
import { findRepoRoot, readStopRequest, Store, takeUpgradeLock, upgradeLockPath, workersDir, type DriveFn, type DriveOutcome, type ProjectContext, type StopRequest } from "@factory/core";
import { git } from "../../../../packages/core/test/helpers.js";
import { CliError } from "../context.js";
import { parseMaxRuns, refuseRunningOnAnyProject, runStop, runWork, type WorkDeps } from "./work.js";

/** A git repository of its own, as the folder `factory work` is started in. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-work-"));
  git(dir, "init", "-q");
  return findRepoRoot(dir)!;
}

/**
 * Registered projects (in real repositories) with queued issues, and a drive that ends each run
 * with the next scripted outcome. It is started in the first project.
 */
function setup(outcomes: DriveOutcome[], issues = [12], names = ["shop"]) {
  const contexts = names.map((name) => {
    const store = new Store(":memory:");
    const row = store.upsertProject({ name, repo_path: repo(), github_repo: `acme/${name}` });
    for (const number of issues) {
      store.upsertIssue(row.id, { number, title: `Add thing ${number}`, body: "", state: "open", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
      store.setQueued(row.id, number, true);
    }
    const ctx: ProjectContext = { root: row.repo_path, config: factoryConfigSchema.parse({ version: 1 }), store, project: row };
    return ctx;
  });
  const lines: string[] = [];
  let stop: StopRequest | undefined;
  const drive: DriveFn = async (c, number, _options, deps) => {
    const existing = c.store.listRuns({ project_id: c.project.id }).find((r) => r.issue_number === number && !isTerminal(r.state));
    const run = existing ?? c.store.createRun({ project_id: c.project.id, title: `Add thing ${number}`, issue_number: number });
    deps.events?.emit({ type: "run:state", runId: run.id, from: "intake", to: "triage", reason: "start triage" });
    deps.onNotice?.({ type: "started", run, issue: c.store.getIssue(c.project.id, number)!, stop: () => {} });
    const outcome = outcomes.shift() ?? { kind: "finished", state: "done" };
    if (outcome.kind === "parked" || outcome.kind === "finished") c.store.writeState(run.id, outcome.state);
    // Stop once the scripted runs are through, so the worker drains and the test ends.
    if (outcomes.length === 0) stop = { at: Date.now() + 1, now: false };
    return { outcome, run: c.store.getRun(run.id)! };
  };
  const deps: WorkDeps = {
    print: (line) => lines.push(line),
    cwd: contexts[0]!.root,
    projects: () => contexts.map((c) => ({ path: c.root, name: c.project.name, added_at: "t" })),
    reconcile: () => ["finished run abc: its PR was merged"],
    scheduler: {
      open: (entry) => contexts.find((c) => c.root === entry.path)!,
      trustedConfig: () => factoryConfigSchema.parse({ version: 1 }),
      fetchIssue: () => {},
      drive,
      stopRequest: () => stop,
      tickMs: 5,
    },
  };
  return { deps, lines, store: contexts[0]!.store, contexts };
}

describe("runWork", () => {
  it("says to register a project when there is none", async () => {
    await expect(runWork({ all: true }, { projects: () => [] })).rejects.toThrow(/No projects registered/);
  });

  it("works only on the project it was started in", async () => {
    const { deps, lines } = setup([{ kind: "finished", state: "done" }], [12], ["shop", "blog"]);

    await runWork({}, deps);

    expect(lines).toContain("Working through the queue of shop, up to 3 runs at once.");
    expect(lines.some((l) => l.startsWith("[shop#12] Run "))).toBe(true);
    expect(lines.some((l) => l.startsWith("[blog"))).toBe(false);
  }, 30_000);

  it("finds the project from a folder inside it", async () => {
    const { deps, lines, contexts } = setup([{ kind: "finished", state: "done" }], [12], ["shop", "blog"]);
    const inside = join(contexts[1]!.root, "src");
    mkdirSync(inside);

    await runWork({}, { ...deps, cwd: inside });

    expect(lines).toContain("Working through the queue of blog, up to 3 runs at once.");
    expect(lines.some((l) => l.startsWith("[shop"))).toBe(false);
  }, 30_000);

  it("counts a folder inside one of the project's worktrees as the project", async () => {
    const { deps, lines, contexts } = setup([{ kind: "finished", state: "done" }], [12], ["shop", "blog"]);
    const blog = contexts[1]!.root;
    git(blog, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    git(blog, "worktree", "add", "-q", join(blog, ".worktrees", "12-run"));

    await runWork({}, { ...deps, cwd: join(blog, ".worktrees", "12-run") });

    expect(lines).toContain("Working through the queue of blog, up to 3 runs at once.");
  }, 30_000);

  it("works on every registered project with all", async () => {
    const { deps, lines } = setup([{ kind: "finished", state: "done" }, { kind: "finished", state: "done" }], [12], ["shop", "blog"]);

    await runWork({ all: true }, deps);

    expect(lines).toContain("Working through the queues of 2 projects, up to 3 runs at once.");
    expect(lines.some((l) => l.startsWith("[shop#12] Run "))).toBe(true);
    expect(lines.some((l) => l.startsWith("[blog#12] Run "))).toBe(true);
  }, 30_000);

  it("says to use --all when started outside a registered project", async () => {
    const { deps } = setup([]);

    await expect(runWork({}, { ...deps, cwd: repo() })).rejects.toThrow(/not in a registered project.*factory work --all/);
    await expect(runWork({}, { ...deps, cwd: mkdtempSync(join(tmpdir(), "factory-no-repo-")) })).rejects.toThrow(CliError);
  }, 30_000);

  it("says it is running before it opens a project, and stops saying so when it stops", async () => {
    const { deps } = setup([{ kind: "finished", state: "done" }]);
    let during: string[] = [];

    await runWork({}, { ...deps, reconcile: () => ((during = readdirSync(workersDir())), []) });

    expect(during).toHaveLength(1);
    expect(readdirSync(workersDir())).toEqual([]);
  });

  it("refuses to start while `factory upgrade` runs", async () => {
    const { deps } = setup([]);
    // The test runner's pid: alive, and not this process.
    const release = takeUpgradeLock(upgradeLockPath(), process.ppid);
    try {
      await expect(runWork({}, deps)).rejects.toThrow(CliError);
      await expect(runWork({}, deps)).rejects.toThrow(/is replacing the factory .* Start this again once it has finished/);
    } finally {
      release();
    }
  });

  it("prints each run's progress with its project and issue, and stops when asked", async () => {
    const { deps, lines } = setup([{ kind: "finished", state: "done" }]);

    const result = await runWork({ maxRuns: 2 }, deps);

    expect(result).toEqual({ message: "Stopped: no runs are going on.", interrupted: false });
    expect(lines[0]).toBe("[shop] finished run abc: its PR was merged");
    expect(lines).toContain("Working through the queue of shop, up to 2 runs at once.");
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

  it("refuses to work on the project that contains this copy of the factory", async () => {
    const { deps } = setup([]);
    const here = findRepoRoot(process.cwd())!;

    await expect(runWork({}, { ...deps, cwd: here, projects: () => [{ path: here, name: "self", added_at: "t" }] })).rejects.toThrow(/inside the repository it would change/);
  }, 30_000);

  it("refuses to work on a project that contains this copy of the factory, registered while it runs", async () => {
    const { deps, lines } = setup([{ kind: "finished", state: "done" }]);
    const here = findRepoRoot(process.cwd())!;
    const shop = deps.projects!()[0]!;
    // Registered once the start-up checks are through: reconciling comes after them.
    let registered = false;
    const reconcile = () => ((registered = true), []);

    const stopRequest = () => (lines.some((l) => l.includes("Skipped")) ? { at: Date.now() + 1, now: false } : undefined);
    const projects = () => (registered ? [shop, { path: here, name: "self", added_at: "t" }] : [shop]);
    await runWork({ all: true }, { ...deps, projects, reconcile, scheduler: { ...deps.scheduler, stopRequest } });

    expect(lines.some((l) => /^\[self\] Skipped: This copy of the factory \(.+\) is inside the repository/.test(l))).toBe(true);
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
