import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, runCommand, Store, type CommandRunner, type GithubPort, type PullRequestState } from "@factory/core";
import { fakeClaude, git, repoWithRemote, reviewsPass, type FakeStep } from "../../../../packages/core/test/helpers.js";
import { CliError } from "../context.js";
import { createStyle, styleFor, type Style } from "../style.js";
import { runApprove, runCancel, runLogs, runReject, runResume, runRun, runStatus, stopActiveRuns } from "./runs.js";

const ESC = "\x1b[";
// eslint-disable-next-line no-control-regex -- matching escape characters is the point
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const TRIAGE = "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- fine\n";
const BUILD: FakeStep = {
  files: { "feature.txt": "fixed\n" },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", "feat: add feature"],
  ],
  output: "STATUS: READY\nCOMMIT: {{HEAD}}\n\n## Summary\n- done\n",
};

/** PR states the fake GitHub reports; a PR not listed is open. Reset by setup(). */
const prStates = new Map<number, PullRequestState>();
/** PRs the fake GitHub merged. */
const merged: { number: number; head: string }[] = [];
const github: GithubPort = {
  commentOnIssue: () => undefined,
  findPullRequest: () => undefined,
  createDraftPullRequest: () => 7,
  updatePullRequest: () => undefined,
  markReady: () => undefined,
  mergePullRequest: (number, head) => {
    merged.push({ number, head });
    prStates.set(number, { number, state: "merged", draft: false, head, mergeCommit: "e".repeat(40) });
  },
  pullRequestState: (number) => prStates.get(number) ?? { number, state: "open", draft: true, head: "" },
};

function setup(steps: FakeStep[], gates = "triage: auto", extraConfig = "") {
  prStates.clear();
  merged.length = 0;
  const config = `version: 1\nchecks:\n  - name: ok\n    run: node -e "process.exit(0)"\ntrust:\n  authors: [alice]\ngates:\n  review: human\n  ${gates}\n${extraConfig}`;
  const { root: dir } = repoWithRemote({ "README.md": "# demo\n", ".gitignore": ".factory/runs/\n.factory/factory.db*\n.worktrees/\n", ".factory/config.yaml": config });
  const root = findRepoRoot(dir)!;
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  for (const [number, title] of [
    [12, "Add the feature"],
    [13, "Add another feature"],
  ] as const) {
    store.upsertIssue(project.id, {
      number,
      title,
      body: "Add feature.txt",
      state: "open",
      author: "alice",
      labels: [],
      url: `https://github.com/o/r/issues/${number}`,
      gh_updated_at: "2026-01-01T00:00:00Z",
    });
  }
  store.close();

  const fake = fakeClaude(steps);
  const printed: string[] = [];
  const queue = (...numbers: number[]) => {
    const s = new Store(join(root, ".factory", "factory.db"));
    for (const n of numbers.length ? numbers : [12]) s.setQueued(project.id, n, true);
    s.close();
  };
  const deps = { env: fake.env, github, print: (l: string) => printed.push(l) };
  const run = (value = "12", extra: { run?: CommandRunner } = {}) => runRun(dir, [value], {}, { ...deps, ...extra });
  const db = () => new Store(join(root, ".factory", "factory.db"));
  return { dir, root, run, queue, printed, fake, deps, db, projectId: project.id };
}

/** Answers `gh issue view` with the given issue; every other command runs for real (git). */
function fakeGh(issue: { number: number; title: string; state: string; author: string }): CommandRunner {
  return (cmd, args, options) => {
    if (cmd !== "gh") return runCommand(cmd, args, options);
    if (args[0] !== "issue" || args[1] !== "view") return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    const json = {
      number: issue.number,
      title: issue.title,
      body: "Add feature.txt",
      state: issue.state,
      author: { login: issue.author },
      labels: [],
      url: `https://github.com/o/r/issues/${issue.number}`,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    return { code: 0, stdout: JSON.stringify(json), stderr: "" };
  };
}

describe("factory run", () => {
  it("refreshes a synced issue that is not queued yet, queues it, then runs it", async () => {
    const { run, printed } = setup([{ output: TRIAGE }], "triage: human");
    const gh = fakeGh({ number: 12, title: "Add the feature (edited)", state: "OPEN", author: "alice" });

    expect(await run("12", { run: gh })).toMatch(/waiting at the triage gate/);
    expect(printed[0]).toBe("Queued #12 Add the feature (edited)");
  });

  it("refuses an issue closed on GitHub since the last sync", async () => {
    const { run } = setup([]);
    const closed = fakeGh({ number: 12, title: "Add the feature", state: "CLOSED", author: "alice" });
    await expect(run("12", { run: closed })).rejects.toThrow(/#12 is closed/);
  });

  it("fetches an issue that was never synced, queues it and runs it", async () => {
    const { run, printed } = setup([{ output: TRIAGE }], "triage: human");
    const gh = fakeGh({ number: 30, title: "Brand new idea", state: "OPEN", author: "mallory" });

    expect(await run("30", { run: gh })).toMatch(/waiting at the triage gate/);
    expect(printed[0]).toBe("Queued #30 Brand new idea");
    // Running it yourself does not make a stranger's issue trusted.
    expect(printed[1]).toMatch(/not in trust\.authors/);
  });

  it("refuses closed issues and issues GitHub does not have", async () => {
    const { run } = setup([]);
    const closed = fakeGh({ number: 31, title: "Old", state: "CLOSED", author: "alice" });
    await expect(run("31", { run: closed })).rejects.toThrow(/#31 is closed/);
    const missing: CommandRunner = (cmd, args, options) =>
      cmd === "gh" ? { code: 1, stdout: "", stderr: "Could not resolve to an issue" } : runCommand(cmd, args, options);
    await expect(run("32", { run: missing })).rejects.toThrow(/Could not fetch issue #32/);
  });

  it("drives a queued issue to the review gate and says what to do next", async () => {
    const { run, queue, printed, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();

    const message = await run();

    expect(message).toMatch(/waiting at the review gate/);
    expect(message).toMatch(/reviews: code PASS, security PASS, docs PASS/);
    expect(message).toMatch(/See it with: `factory show run-12-\w+`\./);
    expect(message).toContain("factory approve");
    expect(printed).toEqual(expect.arrayContaining(["-> triage: issue loaded", "-> build: triage approved"]));
    expect(printed.some((l) => l.startsWith("[gate] ok: passed"))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);

    const status = runStatus(dir, {}, { github });
    expect(status.split("\n")[0]).toMatch(/^RUN\s+ISSUE\s+STATE\s+ROUND\s+COST\s+WAITING$/);
    expect(status).toMatch(/run-12-\w+\s+#12\s+needs_human\s+b1 r1\s+\$0\.21\s+review/);

    const logs = await runLogs(dir, "#12", {});
    expect(logs).toContain("intake -> triage  issue loaded");
    expect(logs).toMatch(/agent agent-\w+ builder ok \$0\.04/);
    expect(await runLogs(dir, "#12", { follow: true, intervalMs: 10 }, { print: () => undefined })).toMatch(/is needs_human/);
  });
});

describe("factory run with several issues", () => {
  const SLOW_TRIAGE: FakeStep = { output: TRIAGE, sleepMs: 800 };

  /** Each run's triage agent as [started, ended] in ms. */
  function triageSpans(db: Store, projectId: string): Record<number, [number, number]> {
    const spans: Record<number, [number, number]> = {};
    for (const run of db.listRuns({ project_id: projectId })) {
      const agent = db.listAgentRuns(run.id).find((a) => a.role === "triage")!;
      spans[run.issue_number!] = [Date.parse(agent.started_at), Date.parse(agent.ended_at!)];
    }
    db.close();
    return spans;
  }

  it("drives them at the same time and prefixes every line with its issue", async () => {
    const { dir, deps, queue, printed, db, projectId } = setup([SLOW_TRIAGE, SLOW_TRIAGE], "triage: human");
    queue(12, 13);
    const listeners = process.listenerCount("SIGINT");

    const message = await runRun(dir, ["12", "13", "12"], {}, deps);

    // The shared Ctrl+C handler is gone once the last run finishes.
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    const lines = message.split("\n");
    expect(lines[0]).toMatch(/^\[#12\] Run run-12-\w+ is waiting at the triage gate/);
    expect(lines.filter((l) => l.startsWith("[#13] Run run-13-")).length).toBe(1);
    expect(lines.every((l) => /^\[#1[23]\] /.test(l))).toBe(true);
    expect(printed.every((l) => /^\[#1[23]\] /.test(l))).toBe(true);
    expect(printed).toEqual(expect.arrayContaining(["[#12] -> triage: issue loaded", "[#13] -> triage: issue loaded"]));

    const spans = triageSpans(db(), projectId);
    expect(Object.keys(spans).sort()).toEqual(["12", "13"]);
    expect(spans[12]![0]).toBeLessThan(spans[13]![1]);
    expect(spans[13]![0]).toBeLessThan(spans[12]![1]);
  });

  it("runs no more at once than concurrency.max_runs", async () => {
    const { dir, deps, queue, db, projectId } = setup([SLOW_TRIAGE, SLOW_TRIAGE], "triage: human", "concurrency:\n  max_runs: 1\n");
    queue(12, 13);

    await runRun(dir, ["12", "13"], {}, deps);

    const spans = triageSpans(db(), projectId);
    expect(spans[13]![0]).toBeGreaterThanOrEqual(spans[12]![1]);
  });

  it("skips an issue it cannot run, runs the rest, and still fails the command", async () => {
    const { dir, deps, queue } = setup([{ output: TRIAGE }], "triage: human");
    queue(12);
    const closed = fakeGh({ number: 13, title: "Add another feature", state: "CLOSED", author: "alice" });

    const error = await runRun(dir, ["12", "13"], {}, { ...deps, run: closed }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toMatch(/\[#12\] Run run-12-\w+ is waiting at the triage gate/);
    expect(message).toContain("[#13] Skipped: Issue #13 is closed.");
  });

  it("starts no more runs once the usage limit is reached", async () => {
    const { dir, deps, queue, fake } = setup([{ stream: "rate_limited" }], "triage: human", "concurrency:\n  max_runs: 1\n");
    queue(12, 13);

    const message = await runRun(dir, ["12", "13"], {}, deps);

    expect(message).toMatch(/^\[#12\] Usage limit reached/);
    expect(message).toContain("[#13] Not started: the usage limit was reached. Run `factory run 13` after it resets.");
    expect(fake.calls()).toHaveLength(1);
  });

  it("checks every number before queueing or starting anything", async () => {
    const { dir, deps, fake, db, projectId } = setup([]);

    await expect(runRun(dir, ["12", "x"], {}, deps)).rejects.toThrow(/"x" is not an issue number/);

    const store = db();
    expect(store.getIssue(projectId, 12)!.queued_at).toBeFalsy();
    expect(store.listRuns({ project_id: projectId })).toEqual([]);
    store.close();
    expect(fake.calls()).toEqual([]);
  });

  it("Ctrl+C stops every run it is driving and gives back their leases", async () => {
    const hang: FakeStep = { output: TRIAGE, sleepMs: 30_000 };
    const { dir, deps, queue, db, projectId } = setup([hang, hang], "triage: human");
    queue(12, 13);

    const running = runRun(dir, ["12", "13"], {}, deps).catch(() => undefined);
    const store = db();
    const agentsRunning = () =>
      store.listRuns({ project_id: projectId }).filter((r) => store.listAgentRuns(r.id).some((a) => a.status === "running" && a.pid)).length;
    for (let i = 0; i < 200 && agentsRunning() < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(agentsRunning()).toBe(2);

    expect(stopActiveRuns()).toBe(2);

    for (const run of store.listRuns({ project_id: projectId })) {
      expect(store.getRun(run.id)!.lease_owner).toBeNull();
      expect(store.listAgentRuns(run.id).map((a) => a.status)).toEqual(["cancelled"]);
    }
    store.close();
    await running;
  }, 20_000);
});

describe("approve / reject / cancel", () => {
  it("only acts on runs waiting at a gate", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();

    expect(() => runReject(dir, "#12", { message: " " })).toThrow(/Say why/);
    const approved = await runApprove(dir, "#12", { message: "go", run: false });
    expect(approved).toContain("Approved the triage gate");
    expect(approved).toContain("factory run 12");
    expect(runStatus(dir, {}, { github })).toMatch(/\bbuild\b/);
    await expect(runApprove(dir, "#12", {})).rejects.toThrow(/not waiting at a gate \(it is build\)/);
    expect(() => runReject(dir, "#12", { message: "no" })).toThrow(CliError);
  });

  it("keeps driving the run after an approval", async () => {
    const { run, queue, dir, deps, printed, root } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()], "triage: human");
    queue();
    await run();

    const message = await runApprove(dir, "12", { message: "go" }, deps);

    expect(printed.some((l) => /^Approved the triage gate of run-12-\w+; it moves to build\.$/.test(l))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);
    expect(message).toMatch(/waiting at the review gate/);
    // Approving the review gate drives on through capture and the PR to the merge gate.
    expect(await runApprove(dir, "12", {}, deps)).toMatch(/is waiting at the merge gate: waiting at merge gate: gate is set to human/);
    const s = new Store(join(root, ".factory", "factory.db"));
    const runId = s.listRuns({})[0]!.id;
    const head = git(s.getRun(runId)!.worktree_path!, "rev-parse", "HEAD");
    s.close();

    // Approving the merge gate records the commit that waited, and the factory merges exactly it.
    expect(await runApprove(dir, "12", { message: "ship it" }, deps)).toMatch(/finished: done/);
    expect(merged).toEqual([{ number: 7, head }]);
    const after = new Store(join(root, ".factory", "factory.db"));
    expect(after.listDecisions(runId).find((d) => d.comment === "ship it")).toMatchObject({ gate: "merge", commit_sha: head });
    after.close();
  });

  it("records an approval but does not drive a run whose issue was unqueued", async () => {
    const { run, queue, dir, deps, root, fake } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    const s = new Store(join(root, ".factory", "factory.db"));
    s.setQueued(s.listProjects()[0]!.id, 12, false);
    s.close();

    const message = await runApprove(dir, "12", {}, deps);

    expect(message).toMatch(/moves to build\.\nIssue #12 is no longer queued, so the run was not continued/);
    expect(runStatus(dir, {}, { github })).toMatch(/\bbuild\b/);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage"]);
  });

  it("rejects a waiting run with a reason", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    expect(runReject(dir, "#12", { message: "not now" })).toContain("Rejected");
    expect(runStatus(dir, { all: true }, { github })).toMatch(/rejected/);
  });

  it("cancels a run and keeps its worktree", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    const worktrees = join(findRepoRoot(dir)!, ".worktrees");

    const message = runCancel(dir, "run-12", {});

    expect(message).toMatch(/^Cancelled run-12-\w+\./);
    expect(message).toContain("The worktree is kept");
    expect(existsSync(worktrees)).toBe(true);
    expect(git(dir, "worktree", "list")).toContain(".worktrees");
    expect(() => runCancel(dir, "#12", {})).toThrow(/already cancelled/);
    expect(runStatus(dir, {}, { github })).toContain("No active runs");
  });

  it("finishes a run whose PR was merged on GitHub when you look at the status", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    prStates.set(7, { number: 7, state: "merged", draft: false, head: "h", mergeCommit: "c".repeat(40) });

    expect(runStatus(dir, {}, { github })).toMatch(/^run-12-\w+: PR #7 merged -> done\n\nNo active runs/);
    expect(runStatus(dir, { all: true }, { github })).toMatch(/^RUN.*\n.*#12\s+done/);
  });

  it("warns but still shows the status when GitHub cannot be asked", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    const offline: GithubPort = {
      ...github,
      pullRequestState: () => {
        throw new Error("gh: not logged in");
      },
    };

    const status = runStatus(dir, {}, { github: offline });
    expect(status).toMatch(/^warning: could not check PR #7 of run-12-\w+: gh: not logged in\n\nRUN/);
    expect(status).toMatch(/needs_human/);
  });

  it("finishes a run whose PR was closed before running its issue again", async () => {
    const needsInfo = { output: TRIAGE.replace("APPROVE", "NEEDS_INFO") + "\n## Questions\n- Which format?\n" };
    const { run, queue, printed } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass(), needsInfo]);
    queue();
    await run();
    prStates.set(7, { number: 7, state: "closed", draft: true, head: "h" });

    // The old run is cancelled first, so `factory run` starts a new one instead of continuing it.
    expect(await run()).toMatch(/waiting for answers on issue #12/);
    expect(printed.some((l) => /^run-12-\w+: PR #7 closed -> cancelled$/.test(l))).toBe(true);
  });

  it("resumes an escalated run to a stage it may go back to", async () => {
    const blocked = { output: "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nPricing decision needed.\n" };
    const { run, queue, dir } = setup([{ output: TRIAGE }, blocked]);
    queue();
    expect(await run()).toMatch(/needs you: builder is blocked[\s\S]*factory resume/);

    await expect(runApprove(dir, "#12", {})).rejects.toThrow(/not waiting at a gate/);
    await expect(runResume(dir, "#12", { to: "merge", message: "ship" })).rejects.toThrow(/can resume to: .*build/);
    expect(await runResume(dir, "#12", { to: "build", message: "use the flat price", resetLoops: true, run: false })).toBe(
      "Resumed " + runStatus(dir, {}, { github }).split("\n")[1]!.split(/\s+/)[0] + " to build with a fresh loop budget.\nContinue with `factory run 12`.",
    );
    expect(runStatus(dir, {}, { github })).toMatch(/\bbuild\b/);
  });

  it("triages again when the issue was waiting for its author", async () => {
    const needsInfo = { output: TRIAGE.replace("APPROVE", "NEEDS_INFO") + "\n## Questions\n- Which format?\n" };
    const { run, queue, printed } = setup([needsInfo, { output: TRIAGE }], "triage: human");
    queue();
    expect(await run()).toMatch(/waiting for answers on issue #12/);

    expect(await run()).toMatch(/waiting at the triage gate[\s\S]*See it with: `factory show run-12-\w+ triage`/);
    expect(printed).toContain("-> triage: triage again with the current issue text");
  });

  it("keeps driving the run after a resume", async () => {
    const blocked = { output: "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nPricing decision needed.\n" };
    const { run, queue, dir, deps } = setup([{ output: TRIAGE }, blocked, BUILD, ...reviewsPass()]);
    queue();
    await run();

    expect(await runResume(dir, "12", { to: "build", message: "use the flat price" }, deps)).toMatch(/waiting at the review gate/);
  });

  it("explains unknown run references", async () => {
    const { dir } = setup([]);
    await expect(runApprove(dir, "run-nope", {})).rejects.toThrow(/No run "run-nope"/);
    await expect(runApprove(dir, "#99", {})).rejects.toThrow(/No run for issue #99/);
  });
});

describe("colour", () => {
  it("only styles the text: colour on, the plain text is unchanged; NO_COLOR or a pipe gives no escape codes", async () => {
    const colour = createStyle(true);
    const { queue, dir, printed, deps } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();

    const message = await runRun(dir, ["12"], {}, { ...deps, style: colour });

    expect(message).toContain(ESC);
    expect(printed.join("\n")).toContain(ESC);
    const lines = printed.map(strip);
    expect(lines).toEqual(expect.arrayContaining(["-> triage: issue loaded", "-> build: triage approved"]));
    expect(lines.some((l) => /^Run run-12-\w+ \([a-z_]+\) for #12 Add the feature$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[gate\] ok: passed \(\d+\.\ds\)$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[builder\] ok \(\$0\.04\)$/.test(l))).toBe(true);
    expect(strip(message)).toMatch(
      /^Run run-12-\w+ is waiting at the review gate: .+\nSee it with: `factory show run-12-\w+`\.\nApprove with `factory approve run-12-\w+`, or reject with `factory reject run-12-\w+ -m "<why>"`\.$/,
    );

    // status keeps its columns aligned: stripping the codes gives exactly the plain table.
    const status = runStatus(dir, { all: true }, { github, style: colour });
    expect(status).toContain(ESC);
    expect(strip(status)).toBe(runStatus(dir, { all: true }, { github }));

    const logs = await runLogs(dir, "#12", {}, { style: colour });
    expect(logs).toContain(ESC);
    expect(strip(logs)).toBe(await runLogs(dir, "#12", {}));

    const follow = async (style?: Style) => {
      const out: string[] = [];
      const end = await runLogs(dir, "#12", { follow: true, intervalMs: 10 }, { print: (l) => out.push(l), style });
      return [...out, end];
    };
    const followed = await follow(colour);
    expect(followed.join("\n")).toContain(ESC);
    expect(followed.map(strip)).toEqual(await follow());

    for (const style of [styleFor({ isTTY: true }, { NO_COLOR: "1" }), styleFor({ isTTY: false }, {})]) {
      expect(runStatus(dir, { all: true }, { github, style })).not.toContain(ESC);
      expect(await runLogs(dir, "#12", {}, { style })).not.toContain(ESC);
      expect((await follow(style)).join("\n")).not.toContain(ESC);
    }
  });
});
