import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVerdict } from "@factory/shared";
import { fakeClaude, git, repoWithRemote, type FakeStep } from "../../test/helpers.js";
import { createAgentRunner } from "../agents/runner.js";
import { loadTrustedConfig, trustedReader } from "../config/trusted.js";
import { FactoryEvents, type FactoryEvent } from "../events.js";
import type { GithubPort } from "../github/port.js";
import { Store } from "../store/store.js";
import { PipelineDriver, runDirOf } from "./driver.js";

const TRIAGE = (decision = "APPROVE", extra = "") =>
  `DECISION: ${decision}\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- looks fine\n${extra}`;
const READY = "STATUS: READY\nCOMMIT: {{HEAD}}\n\n## Summary\n- done\n";

/** A builder round that writes feature.txt, commits and pushes, then reports READY. */
const buildStep = (content: string, output = READY): FakeStep => ({
  files: { "feature.txt": `${content}\n` },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", `feat: ${content}`],
    ["git", "push", "-q", "-u", "origin", "HEAD"],
  ],
  output,
});

// The gate passes only once feature.txt says "fixed".
const CHECK_JS = `const fs = require("fs");
const ok = fs.existsSync("feature.txt") && fs.readFileSync("feature.txt", "utf8").trim() === "fixed";
if (!ok) console.error("feature.txt is not fixed yet");
process.exit(ok ? 0 : 1);
`;

function setup(steps: FakeStep[], options: { author?: string; config?: string } = {}) {
  const config =
    options.config ??
    "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n";
  const { root } = repoWithRemote({
    "README.md": "# demo\n",
    "check.js": CHECK_JS,
    ".gitignore": ".factory/runs/\n.worktrees/\n",
    ".factory/config.yaml": config,
  });
  const fake = fakeClaude(steps);
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.upsertIssue(project.id, {
    number: 12,
    title: "Add the feature",
    body: "Please add feature.txt.",
    state: "open",
    author: options.author ?? "alice",
    labels: [],
    url: "https://github.com/o/r/issues/12",
    gh_updated_at: "2026-01-01T00:00:00Z",
  });
  store.setQueued(project.id, 12, true);

  const comments: { issue: number; body: string }[] = [];
  const github: GithubPort = {
    commentOnIssue: (issue, body) => comments.push({ issue, body }),
    findPullRequest: (branch) => (git(root, "ls-remote", "origin", `refs/heads/${branch}`) ? 7 : undefined),
  };
  const events = new FactoryEvents();
  const seen: FactoryEvent[] = [];
  events.on((e) => seen.push(e));

  const read = trustedReader(root, "main");
  const driver = new PipelineDriver({
    store,
    project,
    config: loadTrustedConfig(read, "main"),
    read,
    runAgent: createAgentRunner({ store, events, env: fake.env }),
    github,
    owner: "test-worker",
    events,
  });
  return { root, store, project, driver, fake, comments, seen };
}

describe("PipelineDriver", () => {
  it("approves, builds, fails the gate, fixes it, passes and parks at review", async () => {
    const { driver, store, fake, root, seen } = setup([
      { output: TRIAGE() },
      buildStep("broken"),
      buildStep("fixed"),
    ]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    const done = store.getRun(run.id)!;
    expect(done).toMatchObject({ waiting_gate: "review", build_iterations: 1, pr_number: 7, branch: "factory/12-add-the-feature" });
    expect(done.lease_owner).toBeNull();
    expect(done.port_base).toBe(4700);

    const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
    expect(moves).toEqual(["->intake", "intake>triage", "triage>build", "build>gate", "gate>build", "build>gate", "gate>needs_human"]);

    const dir = runDirOf(root, run.id);
    const head = git(done.worktree_path!, "rev-parse", "HEAD");
    expect(parseVerdict("checks", readFileSync(join(dir, "round-1", "checks.md"), "utf8")).header.GATE).toBe("FAIL");
    expect(parseVerdict("checks", readFileSync(join(dir, "round-2", "checks.md"), "utf8")).header).toEqual({ GATE: "PASS", COMMIT: head });
    expect(existsSync(join(dir, "issue.md"))).toBe(true);

    const calls = fake.calls();
    expect(calls.map((c) => c.role)).toEqual(["triage", "builder", "builder"]);
    expect(calls[0]!.cwd.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
    expect(calls[1]!.stdin).toContain("## Triage result");
    expect(calls[2]!.stdin).toContain("The quality gate failed in round 1");
    expect(calls[2]!.stdin).toContain("feature.txt is not fixed yet");
    const firstSession = calls[1]!.argv[calls[1]!.argv.indexOf("--session-id") + 1];
    expect(calls[2]!.argv).toEqual(expect.arrayContaining(["--resume", firstSession]));

    expect(store.listDecisions(run.id)).toMatchObject([{ gate: "triage", outcome: "proceed", actor: "agent" }]);
    expect(seen.some((e) => e.type === "gate:check" && e.passed)).toBe(true);
  });

  it("escalates when the gate keeps failing past max_build_iterations", async () => {
    const config =
      "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: always\nloops:\n  max_build_iterations: 2\n";
    const { driver, store } = setup([{ output: TRIAGE() }, buildStep("broken 1"), buildStep("broken 2")], { config });
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(outcome.kind === "parked" && outcome.reason).toMatch(/still failing after round 2.*cap reached \(2\)/);
    expect(store.getRun(run.id)!.build_iterations).toBe(1);
  });

  it("waits for a human at triage for an untrusted author, even when the gate is set to always", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: always\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }], { author: "mallory", config });
    const run = driver.startRun(12, { unsafe: true });

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(store.getRun(run.id)!.waiting_gate).toBe("triage");
    expect(store.listDecisions(run.id)).toMatchObject([{ gate: "triage", outcome: "escalate", actor: "system" }]);
    expect(fake.calls()[0]!.stdin).toContain("NOT a trusted author");
    expect(fake.calls()).toHaveLength(1);
  });

  it("parks at the triage gate when it is set to human", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { driver, store } = setup([{ output: TRIAGE() }], { config });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("gate is set to human") });
    expect(store.getRun(run.id)!.waiting_gate).toBe("triage");
  });

  it("posts the reasons and ends the run when triage rejects", async () => {
    const { driver, store, comments } = setup([{ output: TRIAGE("REJECT", "\n## Reasons\n- duplicate of #3\n") }]);
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "rejected" });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.issue).toBe(12);
    expect(comments[0]!.body).toMatch(new RegExp(`^<!-- factory:${run.id}:triage-reject -->`));
    expect(comments[0]!.body).toContain("duplicate of #3");
    expect(store.getRun(run.id)!.lease_owner).toBeNull();
  });

  it("asks the questions and parks in needs_info", async () => {
    const { driver, comments } = setup([{ output: TRIAGE("NEEDS_INFO", "\n## Questions\n- Which format?\n") }]);
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", state: "needs_info" });
    expect(comments[0]!.body).toContain("Which format?");
  });

  it("stops without changing state when the usage limit is hit", async () => {
    const { driver, store } = setup([{ stream: "rate_limited" }]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toEqual({ kind: "rate_limited", resetsAt: new Date(1893456000 * 1000).toISOString() });
    expect(store.getRun(run.id)).toMatchObject({ state: "triage", lease_owner: null });
  });

  it("escalates when the builder's hand-over is rejected twice", async () => {
    const notPushed: FakeStep = {
      files: { "feature.txt": "fixed\n" },
      exec: [
        ["git", "add", "-A"],
        ["git", "commit", "-qm", "feat: x"],
      ],
      output: READY,
    };
    const { driver, store, fake } = setup([{ output: TRIAGE() }, notPushed, { output: READY }]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome.kind === "parked" && outcome.reason).toMatch(/builder output was rejected twice: .*not pushed/);
    expect(fake.calls()[2]!.stdin).toContain("the branch is not pushed");
    expect(store.getRun(run.id)!.state).toBe("needs_human");
  });

  it("escalates when the builder is blocked", async () => {
    const blocked = "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nNeeds a product decision on pricing.\n";
    const { driver } = setup([{ output: TRIAGE() }, { output: blocked }]);
    const run = driver.startRun(12);
    const outcome = await driver.drive(run.id);
    expect(outcome.kind === "parked" && outcome.reason).toContain("Needs a product decision on pricing.");
  });

  it("does not start a second run for the same issue, and refuses unqueued issues", () => {
    const { driver, store, project } = setup([]);
    const run = driver.startRun(12);
    expect(driver.startRun(12).id).toBe(run.id);
    store.setQueued(project.id, 12, false);
    store.writeState(run.id, "cancelled");
    expect(() => driver.startRun(12)).toThrow(/not queued/);
  });

  it("will not drive a run another worker holds", async () => {
    const { driver, store } = setup([]);
    const run = driver.startRun(12);
    store.acquireLease(run.id, "someone-else", 60_000);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "stopped", reason: expect.stringContaining("someone-else") });
  });
});
