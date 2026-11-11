import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, runCommand, Store, type CommandRunner, type GithubPort } from "@factory/core";
import { fakeClaude, git, repoWithRemote, type FakeStep } from "../../../../packages/core/test/helpers.js";
import { CliError } from "../context.js";
import { runApprove, runCancel, runLogs, runReject, runResume, runRun, runStatus } from "./runs.js";

const TRIAGE = "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- fine\n";
const BUILD: FakeStep = {
  files: { "feature.txt": "fixed\n" },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", "feat: add feature"],
  ],
  output: "STATUS: READY\nCOMMIT: {{HEAD}}\n\n## Summary\n- done\n",
};

function setup(steps: FakeStep[], gates = "triage: auto") {
  const config = `version: 1\nchecks:\n  - name: ok\n    run: node -e "process.exit(0)"\ntrust:\n  authors: [alice]\ngates:\n  ${gates}\n`;
  const { root: dir } = repoWithRemote({ "README.md": "# demo\n", ".gitignore": ".factory/runs/\n.factory/factory.db*\n.worktrees/\n", ".factory/config.yaml": config });
  const root = findRepoRoot(dir)!;
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.upsertIssue(project.id, {
    number: 12,
    title: "Add the feature",
    body: "Add feature.txt",
    state: "open",
    author: "alice",
    labels: [],
    url: "https://github.com/o/r/issues/12",
    gh_updated_at: "2026-01-01T00:00:00Z",
  });
  store.close();

  const fake = fakeClaude(steps);
  const github: GithubPort = { commentOnIssue: () => undefined, findPullRequest: () => undefined, createDraftPullRequest: () => 7 };
  const printed: string[] = [];
  const queue = () => {
    const s = new Store(join(root, ".factory", "factory.db"));
    s.setQueued(project.id, 12, true);
    s.close();
  };
  const deps = { env: fake.env, github, print: (l: string) => printed.push(l) };
  const run = (value = "12", extra: { run?: CommandRunner } = {}) => runRun(dir, value, {}, { ...deps, ...extra });
  return { dir, root, run, queue, printed, fake, deps };
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
    const { run, queue, printed, dir } = setup([{ output: TRIAGE }, BUILD]);
    queue();

    const message = await run();

    expect(message).toMatch(/waiting at the review gate/);
    expect(message).toMatch(/See it with: `factory show run-12-\w+ build`/);
    expect(message).toContain("factory approve");
    expect(printed).toEqual(expect.arrayContaining(["-> triage: issue loaded", "-> build: triage approved"]));
    expect(printed.some((l) => l.startsWith("[gate] ok: passed"))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);

    const status = runStatus(dir);
    expect(status.split("\n")[0]).toMatch(/^RUN\s+ISSUE\s+STATE\s+ROUND\s+COST\s+WAITING$/);
    expect(status).toMatch(/run-12-\w+\s+#12\s+needs_human\s+b1 r1\s+\$0\.08\s+review/);

    const logs = await runLogs(dir, "#12", {});
    expect(logs).toContain("intake -> triage  issue loaded");
    expect(logs).toMatch(/agent agent-\w+ builder ok \$0\.04/);
    expect(await runLogs(dir, "#12", { follow: true, intervalMs: 10 }, { print: () => undefined })).toMatch(/is needs_human/);
  });
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
    expect(runStatus(dir)).toMatch(/\bbuild\b/);
    await expect(runApprove(dir, "#12", {})).rejects.toThrow(/not waiting at a gate \(it is build\)/);
    expect(() => runReject(dir, "#12", { message: "no" })).toThrow(CliError);
  });

  it("keeps driving the run after an approval", async () => {
    const { run, queue, dir, deps, printed } = setup([{ output: TRIAGE }, BUILD], "triage: human");
    queue();
    await run();

    const message = await runApprove(dir, "12", { message: "go" }, deps);

    expect(printed.some((l) => /^Approved the triage gate of run-12-\w+; it moves to build\.$/.test(l))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);
    expect(message).toMatch(/waiting at the review gate/);
    // Approving the review gate has nothing to drive yet.
    expect(await runApprove(dir, "12", {}, deps)).toMatch(/moves to review\.\nReviews are not automated yet/);
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
    expect(runStatus(dir)).toMatch(/\bbuild\b/);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage"]);
  });

  it("rejects a waiting run with a reason", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    expect(runReject(dir, "#12", { message: "not now" })).toContain("Rejected");
    expect(runStatus(dir, { all: true })).toMatch(/rejected/);
  });

  it("cancels a run and keeps its worktree", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD]);
    queue();
    await run();
    const worktrees = join(findRepoRoot(dir)!, ".worktrees");

    const message = runCancel(dir, "run-12", {});

    expect(message).toMatch(/^Cancelled run-12-\w+\./);
    expect(message).toContain("The worktree is kept");
    expect(existsSync(worktrees)).toBe(true);
    expect(git(dir, "worktree", "list")).toContain(".worktrees");
    expect(() => runCancel(dir, "#12", {})).toThrow(/already cancelled/);
    expect(runStatus(dir)).toContain("No active runs");
  });

  it("resumes an escalated run to a stage it may go back to", async () => {
    const blocked = { output: "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nPricing decision needed.\n" };
    const { run, queue, dir } = setup([{ output: TRIAGE }, blocked]);
    queue();
    expect(await run()).toMatch(/needs you: builder is blocked[\s\S]*factory resume/);

    await expect(runApprove(dir, "#12", {})).rejects.toThrow(/not waiting at a gate/);
    await expect(runResume(dir, "#12", { to: "merge", message: "ship" })).rejects.toThrow(/can resume to: .*build/);
    expect(await runResume(dir, "#12", { to: "build", message: "use the flat price", resetLoops: true, run: false })).toBe(
      "Resumed " + runStatus(dir).split("\n")[1]!.split(/\s+/)[0] + " to build with a fresh loop budget.\nContinue with `factory run 12`.",
    );
    expect(runStatus(dir)).toMatch(/\bbuild\b/);
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
    const { run, queue, dir, deps } = setup([{ output: TRIAGE }, blocked, BUILD]);
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
