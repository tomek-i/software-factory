import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema, parseVerdict } from "@factory/shared";
import { fakeClaude, git, repoWithRemote, type FakeStep } from "../../test/helpers.js";
import { createAgentRunner } from "../agents/runner.js";
import { loadTrustedConfig, trustedReader } from "../config/trusted.js";
import { FactoryEvents, type FactoryEvent } from "../events.js";
import type { GithubPort } from "../github/port.js";
import { Store } from "../store/store.js";
import { PipelineDriver, prBody, runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

const TRIAGE = (decision = "APPROVE", extra = "") =>
  `DECISION: ${decision}\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- looks fine\n${extra}`;
const READY = "STATUS: READY\nCOMMIT: {{HEAD}}\n\n## Summary\n- done\n";

/** A builder round that writes feature.txt and commits it (the engine pushes), then reports READY. */
const buildStep = (content: string, output = READY): FakeStep => ({
  files: { "feature.txt": `${content}\n` },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", `feat: ${content}`],
  ],
  output,
});

// Built by concatenation so this file contains no secret-shaped string.
const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

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
  const prs: { head: string; base: string; title: string; body: string }[] = [];
  const github: GithubPort = {
    commentOnIssue: (issue, body) => comments.push({ issue, body }),
    findPullRequest: (branch) => (prs.some((p) => p.head === branch) ? 7 : undefined),
    createDraftPullRequest: (pr) => {
      prs.push(pr);
      return 7;
    },
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
    watchMs: 50,
  });
  return { root, store, project, driver, fake, comments, prs, seen };
}

describe("PipelineDriver", () => {
  it("approves, builds, fails the gate, fixes it, passes and parks at review", async () => {
    const { driver, store, fake, root, seen, prs } = setup([
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

    // The engine pushed and opened one draft PR; the second round reused it.
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature").split(/\s+/)[0]).toBe(head);
    expect(prs).toEqual([{ head: "factory/12-add-the-feature", base: "main", title: "Add the feature", body: "## What\n- done\n\nCloses #12\n" }]);
  });

  it("runs each agent with its configured model and effort, upgraded when triage said HIGH", async () => {
    const config = [
      "version: 1",
      "checks:",
      "  - name: feature",
      "    run: node check.js",
      "trust:",
      "  authors: [alice]",
      "gates:",
      "  triage: always",
      "models:",
      "  default: opus",
      "  effort: high",
      "  roles:",
      "    triage: { model: fable, effort: medium }",
      "    builder: sonnet",
      "  high_risk:",
      "    builder: { effort: xhigh }",
      "",
    ].join("\n");
    const { driver, store, fake } = setup([{ output: TRIAGE().replace("RISK: LOW", "RISK: HIGH") }, buildStep("fixed")], { config });
    const run = driver.startRun(12);

    await driver.drive(run.id);

    const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
    const [triage, builder] = fake.calls();
    expect([flag(triage!.argv, "--model"), flag(triage!.argv, "--effort")]).toEqual(["fable", "medium"]);
    expect([flag(builder!.argv, "--model"), flag(builder!.argv, "--effort")]).toEqual(["sonnet", "xhigh"]);
    expect(store.listAgentRuns(run.id).map((a) => [a.role, a.model, a.effort])).toEqual([
      ["triage", "fable", "medium"],
      ["builder", "sonnet", "xhigh"],
    ]);
  });

  it("never pushes a secret: the builder must remove it from its commits first", async () => {
    const leaky: FakeStep = {
      files: { "config.js": `module.exports = "${FAKE_AWS_KEY}";\n`, "feature.txt": "fixed\n" },
      exec: [
        ["git", "add", "-A"],
        ["git", "commit", "-qm", "feat: add feature"],
      ],
      output: READY,
    };
    const cleaned: FakeStep = {
      files: { "config.js": "module.exports = process.env.KEY;\n" },
      exec: [
        ["git", "reset", "-q", "--soft", "origin/main"],
        ["git", "add", "-A"],
        ["git", "commit", "-qm", "feat: add feature"],
      ],
      output: READY,
    };
    const { driver, store, fake, root } = setup([{ output: TRIAGE() }, leaky, cleaned]);
    const run = driver.startRun(12);

    await driver.drive(run.id);

    expect(fake.calls()[2]!.stdin).toContain("possible secret in config.js:1 (aws-access-key-id)");
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", waiting_gate: "review" });
    const published = git(root, "log", "-p", "origin/factory/12-add-the-feature");
    expect(published).not.toContain(FAKE_AWS_KEY);
  });

  it("stops the running agent promptly when the run is cancelled from elsewhere", async () => {
    const { driver, store } = setup([{ output: TRIAGE() }, { sleepMs: 30_000 }]);
    const run = driver.startRun(12);
    const started = Date.now();
    const cancelWhenBuilding = setInterval(() => {
      if (store.listAgentRuns(run.id).some((a) => a.role === "builder" && a.status === "running")) {
        clearInterval(cancelWhenBuilding);
        new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(run.id, "changed my mind");
      }
    }, 50);

    const outcome = await driver.drive(run.id);

    clearInterval(cancelWhenBuilding);
    expect(outcome).toEqual({ kind: "finished", state: "cancelled" });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(store.listAgentRuns(run.id).at(-1)).toMatchObject({ role: "builder", status: "cancelled" });
  });

  it("tells the builder only about human decisions made since it last ran", async () => {
    const config = "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }, buildStep("broken"), buildStep("fixed")], { config });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "approved the triage" });

    await driver.drive(run.id);

    expect(fake.calls()[2]!.stdin).toContain("The quality gate failed in round 1");
    expect(fake.calls()[2]!.stdin).not.toContain("approved the triage");
  });

  it("closes agent rows left running by a worker that died", async () => {
    const { driver, store, root } = setup([{ stream: "rate_limited" }]);
    const run = driver.startRun(12);
    const orphan = store.startAgentRun({ run_id: run.id, role: "triage", model: "opus", session_id: "s", log_dir: root });
    store.setAgentPid(orphan.id, 999999);

    await driver.drive(run.id);

    expect(store.getAgentRun(orphan.id)).toMatchObject({ status: "error", pid: null });
  });

  it("triages again after the author was asked for information", async () => {
    const config = "version: 1\nchecks: []\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { driver, store } = setup([{ output: TRIAGE("NEEDS_INFO", "\n## Questions\n- Which format?\n") }, { output: TRIAGE() }], { config });
    const run = driver.startRun(12);
    await driver.drive(run.id);
    expect(store.getRun(run.id)!.state).toBe("needs_info");

    driver.retriage(run.id);
    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(store.getRun(run.id)!.waiting_gate).toBe("triage");
    expect(() => driver.retriage(run.id)).toThrow(/not waiting for information/);
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
    const uncommitted: FakeStep = { files: { "feature.txt": "fixed\n" }, output: READY };
    const { driver, store, fake, root } = setup([{ output: TRIAGE() }, uncommitted, { output: READY }]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome.kind === "parked" && outcome.reason).toMatch(/builder output was rejected twice: .*uncommitted changes/);
    expect(fake.calls()[2]!.stdin).toContain("the worktree has uncommitted changes");
    expect(store.getRun(run.id)!.state).toBe("needs_human");
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature")).toBe("");
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

describe("prBody", () => {
  it("puts the human brief first and collapses the implementation details", () => {
    const build = [
      "STATUS: READY",
      "COMMIT: abc",
      "",
      "## Summary",
      "- Stops a run that keeps failing the same way",
      "",
      "## Testing",
      "- unit and driver tests",
      "",
      "## Details",
      "- `fingerprint.ts`: hashes failed checks",
      "",
    ].join("\n");
    expect(prBody(build, 16)).toBe(
      [
        "## What",
        "- Stops a run that keeps failing the same way",
        "",
        "## How it was tested",
        "- unit and driver tests",
        "",
        "<details><summary>Implementation details</summary>",
        "",
        "- `fingerprint.ts`: hashes failed checks",
        "",
        "</details>",
        "",
        "Closes #16",
        "",
      ].join("\n"),
    );
  });

  it("leaves out sections the builder did not write", () => {
    expect(prBody("STATUS: READY\n\n## Summary\n- done\n", 3)).toBe("## What\n- done\n\nCloses #3\n");
    expect(prBody("STATUS: READY\n", 3)).toBe("Closes #3\n");
  });
});
