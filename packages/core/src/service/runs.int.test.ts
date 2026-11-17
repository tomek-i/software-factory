import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setup, TRIAGE } from "../../test/driver-setup.js";
import { loadConfig } from "../config/load.js";
import { FactoryEvents, type FactoryEvent } from "../events.js";
import { MEDIA_MARKER, mediaTag } from "../github/media.js";
import { runDirOf } from "../pipeline/driver.js";
import { FACTORY_CLAIM_PENDING, NEVER_SYNCED } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { ServiceError } from "./errors.js";
import {
  approveRun,
  cancelRun,
  continuation,
  driveIssue,
  dropMedia,
  ensureQueued,
  findRun,
  rejectRun,
  resumeRun,
  runCost,
  trustedConfig,
  type DriveNotice,
  type ServiceContext,
} from "./runs.js";

const HUMAN_TRIAGE = "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";

/** The shared driver setup as a service context: its in-memory store, project and working-copy config. */
function context(steps: Parameters<typeof setup>[0] = [], config = HUMAN_TRIAGE) {
  const s = setup(steps, { config });
  const ctx: ServiceContext = { store: s.store, project: s.project, config: loadConfig(s.root) };
  return { ...s, ctx };
}

/** Drive issue 12 the way a front end does, keeping every notice and event. */
async function drive(s: ReturnType<typeof context>, options: { unsafe?: boolean } = {}) {
  const notices: DriveNotice[] = [];
  const seen: FactoryEvent[] = [];
  const events = new FactoryEvents();
  events.on((e) => seen.push(e));
  const driven = await driveIssue(s.ctx, 12, options, { owner: "test-service", env: s.fake.env, github: s.github, events, onNotice: (n) => notices.push(n) });
  return { ...driven, notices, seen };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Answers `gh issue view` with the given issue and `gh api user` with the login, and fails `gh release delete`; git runs for real. */
function fakeGh(issue?: { number: number; state: string; author: string }, login?: string): CommandRunner {
  return (cmd, args, options) => {
    if (cmd !== "gh") return runCommand(cmd, args, options);
    if (args[0] === "api" && args[1] === "user" && login) return { code: 0, stdout: JSON.stringify({ login }), stderr: "" };
    if (args[0] === "issue" && args[1] === "view" && issue) {
      const json = { number: issue.number, title: `Issue ${issue.number}`, body: "", state: issue.state, author: { login: issue.author }, labels: [], url: "u", updatedAt: "2026-01-01T00:00:00Z" };
      return { code: 0, stdout: JSON.stringify(json), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `no access\nmore detail` };
  };
}

describe("findRun", () => {
  it("finds a run by full id, unique prefix or #issue, and otherwise says why not", () => {
    const { store, project } = context();
    const first = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });
    const second = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });

    expect(findRun(store, project, first.id).id).toBe(first.id);
    expect(findRun(store, project, second.id.slice(0, -1)).id).toBe(second.id);
    expect(findRun(store, project, "#12").id).toBe(store.listRuns({ project_id: project.id })[0]!.id);
    expect(() => findRun(store, project, "12-")).toThrow(new ServiceError('"12-" matches several runs; use more of the id.'));
    expect(() => findRun(store, project, "nope")).toThrow(new ServiceError('No run "nope". See `factory status`.'));
    expect(() => findRun(store, project, "#13")).toThrow(new ServiceError("No run for issue #13."));
    expect(() => findRun(store, project, "#0")).toThrow(new ServiceError('"#0" is not an issue number'));
  });
});

describe("ensureQueued", () => {
  it("leaves a queued issue alone, and fetches and queues one that is not", () => {
    const { ctx } = context();
    expect(ensureQueued(ctx, 12)).toMatchObject({ issue: { number: 12 }, queued: false, trusted: true });

    const fetched = ensureQueued(ctx, 13, fakeGh({ number: 13, state: "OPEN", author: "bob" }));

    expect(fetched).toMatchObject({ issue: { number: 13, title: "Issue 13" }, queued: true, trusted: false });
    expect(ctx.store.getIssue(ctx.project.id, 13)!.queued_at).not.toBeNull();
  });

  it("fetches an issue an import queued before using it, and settles the factory claim the file made for it", () => {
    const { ctx } = context();
    // As `factory import` leaves an issue new to this store: queued, nothing from GitHub yet, claimed for the factory.
    ctx.store.db
      .prepare("UPDATE issues SET title = '', author = '', synced_at = ?, created_by_factory = ? WHERE project_id = ? AND number = 12")
      .run(NEVER_SYNCED, FACTORY_CLAIM_PENDING, ctx.project.id);
    expect(() => ensureQueued(ctx, 12, fakeGh())).toThrow(/^Could not fetch issue #12: /);

    const fetched = ensureQueued(ctx, 12, fakeGh({ number: 12, state: "OPEN", author: "bob" }, "factory-bot"));
    // bob opened it, not the factory's login, and bob is not trusted: the file's claim is dropped.
    expect(fetched).toMatchObject({ issue: { number: 12, title: "Issue 12", author: "bob", created_by_factory: false }, queued: false, trusted: false });
    expect(ctx.store.pendingFactoryClaims(ctx.project.id, [12])).toEqual([]);
  });

  it("refuses a closed issue and one that cannot be fetched, without queueing either", () => {
    const { ctx } = context();
    expect(() => ensureQueued(ctx, 14, fakeGh({ number: 14, state: "CLOSED", author: "alice" }))).toThrow(new ServiceError("Issue #14 is closed."));
    expect(ctx.store.getIssue(ctx.project.id, 14)!.queued_at).toBeNull();
    expect(() => ensureQueued(ctx, 15, fakeGh())).toThrow(/^Could not fetch issue #15: /);
    expect(ctx.store.getIssue(ctx.project.id, 15)).toBeUndefined();
  });
});

describe("driveIssue", () => {
  it("continues only the run it was given: one that ended since is left, and no new run is made", async () => {
    const s = context();
    const picked = s.store.createRun({ project_id: s.project.id, title: "Add the feature", issue_number: 12 });
    s.store.writeState(picked.id, "cancelled");

    const driven = await driveIssue(s.ctx, 12, { runId: picked.id }, { owner: "work-test", env: s.fake.env, github: s.github });

    expect(driven.outcome).toMatchObject({ kind: "stopped", state: "cancelled" });
    expect(s.store.listRuns({ project_id: s.project.id })).toHaveLength(1);
    expect(s.fake.calls()).toEqual([]);
    await expect(driveIssue(s.ctx, 13, { runId: picked.id }, { owner: "work-test", env: s.fake.env, github: s.github })).rejects.toThrow(ServiceError);
  });

  it("leaves a run waiting for its author parked when told not to retriage", async () => {
    const s = context();
    const run = s.store.createRun({ project_id: s.project.id, title: "Add the feature", issue_number: 12 });
    s.store.writeState(run.id, "needs_info");

    const driven = await driveIssue(s.ctx, 12, { retriage: false }, { owner: "work-test", env: s.fake.env, github: s.github });

    expect(driven.outcome).toMatchObject({ kind: "parked", state: "needs_info" });
    expect(s.fake.calls()).toEqual([]);
  });

  it("reports what happens before the run moves, streams events, and returns the outcome and run", async () => {
    const s = context([{ output: TRIAGE() }], HUMAN_TRIAGE.replace(/checks:\n.*\n.*\n/, ""));

    const { outcome, run, notices, seen } = await drive(s);

    expect(notices.map((n) => n.type)).toEqual(["no_checks", "started"]);
    expect(notices[1]).toMatchObject({ type: "started", run: { id: run.id, issue_number: 12 }, issue: { title: "Add the feature" } });
    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(run).toMatchObject({ state: "needs_human", waiting_gate: "triage", lease_owner: null });
    expect(seen.some((e) => e.type === "agent:start")).toBe(true);

    // Asking for --unsafe on a run that exists without it is ignored, and said so.
    const again = await drive(s, { unsafe: true });
    expect(again.notices.map((n) => n.type)).toEqual(["no_checks", "unsafe_ignored", "started"]);
    expect(again.run.unsafe).toBeFalsy();
  });

  it("gives a front end a stop that, while the run is driven, kills its agent and frees the lease", async () => {
    // The triage agent takes long enough that stop comes while it is working, as a Ctrl+C would.
    const s = context([{ output: TRIAGE(), sleepMs: 60_000 }]);
    let stop: (() => void) | undefined;
    let runId = "";
    const seen: { pid: number; status: string; leaseOwner: string | null }[] = [];
    const watch = setInterval(() => {
      const agent = runId ? s.store.listAgentRuns(runId).find((a) => a.status === "running" && a.pid) : undefined;
      if (!agent || !stop) return;
      clearInterval(watch);
      stop();
      seen.push({ pid: agent.pid!, status: s.store.getAgentRun(agent.id)!.status, leaseOwner: s.store.getRun(runId)!.lease_owner });
    }, 20);

    // What the driver does after its agent is killed under it is not the point: the CLI exits right after stop.
    await driveIssue(s.ctx, 12, {}, {
      owner: "test-service",
      env: s.fake.env,
      github: s.github,
      onNotice: (n) => {
        if (n.type !== "started") return;
        runId = n.run.id;
        stop = n.stop;
      },
    }).catch(() => undefined);
    clearInterval(watch);

    expect(seen).toEqual([{ pid: expect.any(Number), status: "cancelled", leaseOwner: null }]);
    expect(isAlive(seen[0]!.pid)).toBe(false);
  });
});

describe("approve, resume, reject and cancel", () => {
  it("approves a waiting gate to where it leads, and says whether the run can be driven on", async () => {
    const s = context([{ output: TRIAGE() }]);
    const { run } = await drive(s);
    expect(() => resumeRun(s.ctx, run.id, { to: "build", message: " " })).toThrow(new ServiceError("Say why with -m."));
    expect(() => resumeRun(s.ctx, run.id, { to: "done", message: "go" })).toThrow(/^Run .+ can resume to: /);

    const approved = approveRun(s.ctx, "#12", { message: "go" });

    expect(approved).toMatchObject({ run: { id: run.id, state: "build", waiting_gate: null }, gate: "triage", to: "build" });
    expect(s.store.listDecisions(run.id).at(-1)).toMatchObject({ gate: "triage", comment: "go" });
    expect(() => approveRun(s.ctx, "#12", {})).toThrow(new ServiceError(`Run ${run.id} is not waiting at a gate (it is build).`));
    expect(() => resumeRun(s.ctx, "#12", { to: "build", message: "go" })).toThrow(new ServiceError(`Run ${run.id} is not waiting for you (it is build).`));

    expect(continuation(s.store, s.project, run, "build")).toBe("ready");
    expect(continuation(s.store, s.project, run, "done")).toBe("ended");
    s.store.setQueued(s.project.id, 12, false);
    expect(continuation(s.store, s.project, run, "build")).toBe("not_queued");
  });

  it("rejects a waiting run, and reports a screenshots release it could not delete", async () => {
    const s = context([{ output: TRIAGE() }]);
    const { run } = await drive(s);
    const runDir = runDirOf(s.root, run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, MEDIA_MARKER), "release\n");
    expect(() => rejectRun(s.ctx, run.id, { message: "" })).toThrow(new ServiceError("Say why with -m."));

    const rejected = rejectRun(s.ctx, run.id, { message: "not now" }, fakeGh());

    expect(rejected).toMatchObject({
      run: { id: run.id, state: "rejected", waiting_gate: null },
      gate: "triage",
      media: { tag: mediaTag(run.id), error: "gh release delete failed: no access" },
    });
    expect(Array.isArray(rejected.cleaned)).toBe(true);
    // Kept, so the next try can delete it.
    expect(existsSync(join(runDir, MEDIA_MARKER))).toBe(true);
    expect(() => rejectRun(s.ctx, run.id, { message: "again" })).toThrow(new ServiceError(`Run ${run.id} is not waiting at a gate (it is rejected).`));
  });

  it("cancels a run no worker drives, with the reason given, and refuses one that already ended", () => {
    const { ctx, store, project } = context();
    const run = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });

    const cancelled = cancelRun(ctx, run.id, "changed my mind");

    expect(cancelled).toEqual({ run: expect.objectContaining({ id: run.id, state: "cancelled" }), stopped: 0, media: undefined, cleaned: [] });
    expect(store.listEvents(run.id).at(-1)!.reason).toBe("human: changed my mind");
    expect(() => cancelRun(ctx, run.id, "again")).toThrow(new ServiceError(`Run ${run.id} is already cancelled.`));
  });

  it("closes the open PR of a run whose issue was closed on GitHub, and only then", () => {
    const { ctx, store, project, github } = context();
    const closed: { number: number; comment: string }[] = [];
    const prState = { state: "open" as "open" | "closed" };
    const issue = { state: "closed" as "open" | "closed" };
    const port = {
      ...github,
      issueState: (number: number) => ({ number, state: issue.state, closedBy: [] }),
      pullRequestState: (number: number) => ({ number, state: prState.state, draft: false, head: "h" }),
      closePullRequest: (number: number, comment: string) => void closed.push({ number, comment }),
    };
    const parked = () => {
      const run = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });
      store.writeState(run.id, "needs_human", { pr_number: 7, waiting_gate: "merge" });
      return run.id;
    };

    // The issue is open: a plain cancel leaves the PR alone.
    expect(cancelRun(ctx, parked(), "not now", { github: port }).closedPr).toBeUndefined();
    expect(closed).toEqual([]);

    store.closeIssue(project.id, 12);
    expect(cancelRun(ctx, parked(), "done elsewhere", { github: port }).closedPr).toBe(7);
    expect(closed).toEqual([{ number: 7, comment: "Issue #12 was closed on GitHub, so the factory's run for it was cancelled." }]);

    // Already closed on GitHub: nothing to do.
    prState.state = "closed";
    expect(cancelRun(ctx, parked(), "again", { github: port }).closedPr).toBeUndefined();

    // GitHub refuses: the run stays as it was, so its open PR is not forgotten.
    prState.state = "open";
    const failing = { ...port, closePullRequest: () => { throw new Error("gh pr close failed: no access\nmore"); } };
    const kept = parked();
    expect(() => cancelRun(ctx, kept, "again", { github: failing })).toThrow(
      new ServiceError(`Run ${kept} was not cancelled: closing PR #7 failed (gh pr close failed: no access). Close the PR on GitHub, and the next sync cancels the run.`),
    );
    expect(store.getRun(kept)!.state).toBe("needs_human");

    // Reopened on GitHub since it was recorded closed: the PR stays, and the issue is open again.
    issue.state = "open";
    expect(cancelRun(ctx, parked(), "restart it", { github: port }).closedPr).toBeUndefined();
    expect(closed).toHaveLength(1);
    expect(store.getIssue(project.id, 12)!.state).toBe("open");
  });

  it("stops the running agent of a run a worker drives, and leaves its cleanup to that worker", async () => {
    const { ctx, store, project, root } = context();
    const run = store.createRun({ project_id: project.id, title: "Add the feature", issue_number: 12 });
    expect(store.acquireLease(run.id, "other-worker", 60_000)).toBe(true);
    // Stands in for the agent process the worker started.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    const agent = store.startAgentRun({ run_id: run.id, role: "builder", model: null, session_id: null, log_dir: root });
    store.setAgentPid(agent.id, child.pid!);

    const cancelled = cancelRun(ctx, run.id, "stop it");

    expect(cancelled).toMatchObject({ run: { id: run.id, state: "cancelled" }, stopped: 1, cleaned: [] });
    await exited;
    expect(isAlive(child.pid!)).toBe(false);
  });
});

describe("dropMedia", () => {
  it("is nothing for a run without a screenshots release, and deletes one that has it", () => {
    const { project, store, root } = context();
    const run = store.createRun({ project_id: project.id, title: "t", issue_number: 12 });
    expect(dropMedia(project, run.id)).toBeUndefined();

    const runDir = runDirOf(root, run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, MEDIA_MARKER), "release\n");
    const calls: string[][] = [];
    const ok: CommandRunner = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "", stderr: "" };
    };

    expect(dropMedia(project, run.id, ok)).toEqual({ tag: mediaTag(run.id) });
    expect(calls).toEqual([["gh", "release", "delete", mediaTag(run.id), "--yes", "-R", "o/r"]]);
    expect(existsSync(join(runDir, MEDIA_MARKER))).toBe(false);
  });
});

describe("runCost and trustedConfig", () => {
  it("sums what a run's agents cost, and reads the config from the default branch", () => {
    const { ctx, store, project, root } = context();
    const run = store.createRun({ project_id: project.id, title: "t", issue_number: 12 });
    for (const cost of [0.5, null, 1.25]) {
      const agent = store.startAgentRun({ run_id: run.id, role: "builder", model: null, session_id: null, log_dir: root });
      store.finishAgentRun(agent.id, { status: "ok", cost_usd: cost });
    }
    expect(runCost(store, run.id)).toBe(1.75);

    // A local edit does not change the rules a run is judged by.
    writeFileSync(join(root, ".factory", "config.yaml"), "version: 1\ngates:\n  triage: always\n");
    expect(trustedConfig(project, loadConfig(root)).gates.triage).toBe("human");
    expect(ctx.config.gates.triage).toBe("human");
  });
});
