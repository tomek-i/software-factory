import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema, parseVerdict, type Finding, type ParsedVerdict } from "@factory/shared";
import { fakeClaude, git, repoWithRemote, REVIEW_PASS, reviewsPass, type FakeStep } from "../../test/helpers.js";
import { absoluteRule } from "../agents/prompts.js";
import { createAgentRunner } from "../agents/runner.js";
import { loadTrustedConfig, trustedReader } from "../config/trusted.js";
import { FactoryEvents, type FactoryEvent } from "../events.js";
import type { GithubPort } from "../github/port.js";
import { Store } from "../store/store.js";
import {
  approveTarget,
  blockingFindings,
  PipelineDriver,
  prBody,
  refutedFindings,
  reviewNotes,
  runDirOf,
  verifyProblems,
  type BlockingFinding,
  type LensReview,
} from "./driver.js";
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

/** A builder round that commits a change but leaves feature.txt broken, so the gate fails the same way. */
const sameFailure = (attempt: number): FakeStep => ({
  files: { "feature.txt": "broken\n", "attempt.txt": `${attempt}\n` },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", `fix: attempt ${attempt}`],
  ],
  output: READY,
});

// The gate passes only once feature.txt says "fixed". A failure names the content, plus noise that
// changes every round (commit, timing, worktree path) and must not hide a repeated failure.
const CHECK_JS = `const fs = require("fs");
const content = fs.existsSync("feature.txt") ? fs.readFileSync("feature.txt", "utf8").trim() : "(missing)";
const ok = content === "fixed";
if (!ok) {
  const head = require("child_process").execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  console.error("checked " + head + " in " + (Date.now() % 997) + "ms at " + process.cwd());
  console.error("feature.txt is not fixed yet: " + content);
}
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
  const edits: { number: number; body: string }[] = [];
  const github: GithubPort = {
    commentOnIssue: (issue, body) => comments.push({ issue, body }),
    findPullRequest: (branch) => (prs.some((p) => p.head === branch) ? 7 : undefined),
    createDraftPullRequest: (pr) => {
      prs.push(pr);
      return 7;
    },
    updatePullRequest: (number, body) => edits.push({ number, body }),
    pullRequestState: (number) => ({ number, state: "open", draft: true, head: "" }),
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
  return { root, store, project, driver, fake, comments, prs, edits, seen };
}

describe("PipelineDriver", () => {
  it("approves, builds, fails the gate, fixes it, passes and parks at review", async () => {
    const { driver, store, fake, root, seen, prs } = setup([
      { output: TRIAGE() },
      buildStep("broken"),
      buildStep("fixed"),
      ...reviewsPass(),
    ]);
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    const done = store.getRun(run.id)!;
    expect(done).toMatchObject({ waiting_gate: "review", build_iterations: 1, pr_number: 7, branch: "factory/12-add-the-feature" });
    expect(done.lease_owner).toBeNull();
    expect(done.port_base).toBe(4700);

    const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
    expect(moves).toEqual(["->intake", "intake>triage", "triage>build", "build>gate", "gate>build", "build>gate", "gate>review", "review>needs_human"]);

    const dir = runDirOf(root, run.id);
    const head = git(done.worktree_path!, "rev-parse", "HEAD");
    expect(parseVerdict("checks", readFileSync(join(dir, "round-1", "checks.md"), "utf8")).header.GATE).toBe("FAIL");
    expect(parseVerdict("checks", readFileSync(join(dir, "round-2", "checks.md"), "utf8")).header).toEqual({ GATE: "PASS", COMMIT: head });
    expect(existsSync(join(dir, "issue.md"))).toBe(true);

    const calls = fake.calls();
    expect(calls.slice(0, 3).map((c) => c.role)).toEqual(["triage", "builder", "builder"]);
    // The three default lenses review the gated commit in the worktree, each into its own file.
    const reviewers = calls.slice(3);
    expect(reviewers.map((c) => c.role).sort()).toEqual(["reviewer-code", "reviewer-docs", "reviewer-security"]);
    for (const reviewer of reviewers) {
      expect(reviewer.cwd.replace(/\\/g, "/")).toBe(done.worktree_path!.replace(/\\/g, "/"));
      expect(reviewer.stdin).toContain(`Commit under review: \`${head}\``);
      expect(reviewer.stdin).toContain(join(dir, "round-2", "change.diff"));
      expect(existsSync(join(dir, "round-2", `${reviewer.role!.replace("reviewer-", "review-")}.md`))).toBe(true);
    }
    expect(calls[0]!.cwd.replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
    expect(calls[1]!.stdin).toContain("## Triage result");
    expect(calls[2]!.stdin).toContain("The quality gate failed in round 1");
    expect(calls[2]!.stdin).toContain("feature.txt is not fixed yet");
    const firstSession = calls[1]!.argv[calls[1]!.argv.indexOf("--session-id") + 1];
    expect(calls[2]!.argv).toEqual(expect.arrayContaining(["--resume", firstSession]));

    expect(store.listDecisions(run.id)).toMatchObject([
      { gate: "triage", outcome: "proceed", actor: "agent" },
      { gate: "review", outcome: "escalate", comment: "reviews: code PASS, security PASS, docs PASS; capture and merge are not automated yet" },
    ]);
    expect(seen.some((e) => e.type === "gate:check" && e.passed)).toBe(true);

    // The engine pushed and opened one draft PR; the second round reused it.
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature").split(/\s+/)[0]).toBe(head);
    expect(prs).toEqual([{ head: "factory/12-add-the-feature", base: "main", title: "Add the feature", body: "## What\n- done\n\nCloses #12\n" }]);
  });

  it("names the hard rules the diff trips when it parks at review, and marks an --unsafe PR", async () => {
    const touchInfra: FakeStep = {
      files: { "feature.txt": "fixed\n", "infra/main.tf": "resource {}\n", ".env": "X=1\n" },
      exec: [
        ["git", "add", "-A"],
        ["git", "commit", "-qm", "feat: infra"],
      ],
      output: READY,
    };
    for (const unsafe of [false, true]) {
      const { driver, store, prs } = setup([{ output: TRIAGE() }, touchInfra, ...reviewsPass()]);
      const run = driver.startRun(12, { unsafe });

      const outcome = await driver.drive(run.id);

      expect(store.getRun(run.id)!.waiting_gate).toBe("review");
      const hits = ["secret or env file changed: .env", "protected path (infra/**): infra/main.tf"];
      // Hard rules hold the gate even though every review passed, unless the run is unsafe.
      const reasons = unsafe
        ? ["capture and merge are not automated yet", `hard rules lifted by --unsafe: ${hits.join("; ")}`]
        : hits.map((h) => `hard rule: ${h}`);
      expect(outcome).toMatchObject({
        kind: "parked",
        state: "needs_human",
        reason: ["waiting at review gate: reviews: code PASS, security PASS, docs PASS", ...reasons].join("; "),
      });
      expect(prs[0]!.body.startsWith("> [!WARNING]\n> Built with `--unsafe`")).toBe(unsafe);
    }
  });

  describe("reviews", () => {
    const reviewConfig = (reviews: string) =>
      `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n${reviews}`;
    const finding = (severity: string) =>
      `## Findings\n\`\`\`json\n[{ "id": "code-1", "severity": "${severity}", "file": "feature.txt", "line": 1, "claim": "it says fixed", "evidence": "line 1" }]\n\`\`\`\n`;
    const review = (verdict: string, severity?: string) => `VERDICT: ${verdict}\n\n## Summary\n- reviewed\n\n${severity ? finding(severity) : "## Findings\nNone.\n"}`;

    it("runs reviews.always, and reviews.ui only when triage says the change touches the UI", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: [ux]\n");
      for (const surfaces of ["api", "api, ui"]) {
        const lenses = surfaces.includes("ui") ? ["code", "ux"] : ["code"];
        const triage = TRIAGE().replace("SURFACES: api", `SURFACES: ${surfaces}`);
        const { driver, fake } = setup([{ output: triage }, buildStep("fixed"), ...reviewsPass(lenses)], { config });
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringContaining(`reviews: ${lenses.map((l) => `${l} PASS`).join(", ")};`) });
        expect(fake.calls().slice(2).map((c) => c.role).sort()).toEqual(lenses.map((l) => `reviewer-${l}`));
      }
    });

    it("runs the reviewers at the same time and waits for all of them", async () => {
      const slow = reviewsPass().map((step) => ({ ...step, sleepMs: 1000 }));
      const { driver, store } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...slow]);
      const run = driver.startRun(12);

      await driver.drive(run.id);

      const reviewers = store.listAgentRuns(run.id).filter((a) => a.role.startsWith("reviewer:"));
      expect(reviewers.map((a) => a.role).sort()).toEqual(["reviewer:code", "reviewer:docs", "reviewer:security"]);
      expect(reviewers.every((a) => a.status === "ok")).toBe(true);
      const lastStart = Math.max(...reviewers.map((a) => Date.parse(a.started_at)));
      const firstEnd = Math.min(...reviewers.map((a) => Date.parse(a.ended_at!)));
      expect(lastStart).toBeLessThan(firstEnd);
    });

    it("never holds the run for minor findings, and lists them in the PR description", async () => {
      const config = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const { driver, fake, edits } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("PASS", "minor") }], { config });
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; capture and merge are not automated yet" });
      expect(fake.calls().some((c) => c.role === "verifier")).toBe(false);
      expect(edits).toHaveLength(1);
      expect(edits[0]!.number).toBe(7);
      expect(edits[0]!.body).toBe(
        "## What\n- done\n\n## Review notes\nLeft for you to judge.\n\n**code**\n- minor: it says fixed (feature.txt:1)\n\nCloses #12\n",
      );
    });

    describe("verifier", () => {
      const codeOnly = reviewConfig("reviews:\n  always: [code]\n  ui: []\n");
      const confirmed = (id = "code-1") =>
        `VERDICT: CONFIRMED\n\n## Summary\n- real\n\n## Findings\n\`\`\`json\n[{ "id": "${id}", "severity": "major", "file": "feature.txt", "line": 1, "claim": "it says fixed", "evidence": "read line 1" }]\n\`\`\`\n`;
      const refuted = "VERDICT: NONE_CONFIRMED\n\n## Summary\n- not real\n\n## Findings\n```json\n[]\n```\n\n## Refuted\n- code-1: the check accepts exactly that\n";
      /** A builder round after review that changes something, so it has a commit to hand over. */
      const rework = (n: number): FakeStep => ({ ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "rework.txt": `${n}\n` } });

      it("sends confirmed findings back to the builder, who gets them, and reviews the next round", async () => {
        const { driver, store, fake, root } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
            rework(1),
            { role: "reviewer-code", output: REVIEW_PASS },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; capture and merge are not automated yet" });
        const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
        expect(moves.slice(3)).toEqual(["build>gate", "gate>review", "review>build", "build>gate", "gate>review", "review>needs_human"]);
        expect(store.getRun(run.id)).toMatchObject({ round: 2, review_rounds: 1, build_iterations: 0 });

        const dir = runDirOf(root, run.id);
        expect(parseVerdict("verify", readFileSync(join(dir, "round-1", "verify.md"), "utf8")).header.VERDICT).toBe("CONFIRMED");
        expect(existsSync(join(dir, "round-2", "review-code.md"))).toBe(true);
        const calls = fake.calls();
        const verifier = calls.find((c) => c.role === "verifier")!;
        expect(verifier.stdin).toContain("## Findings to verify");
        expect(verifier.stdin).toContain('"id": "code-1"');
        expect(verifier.stdin).toContain(join(dir, "round-1", "change.diff"));
        const rebuilt = calls.filter((c) => c.role === "builder")[1]!;
        expect(rebuilt.stdin).toContain("The reviewers of round 1 found problems, and a verifier confirmed these");
        expect(rebuilt.stdin).toContain('"claim": "it says fixed"');
        expect(rebuilt.stdin).not.toContain("quality gate failed");
        // The second round's reviewer is asked about its earlier findings first.
        expect(calls.filter((c) => c.role === "reviewer-code")[1]!.stdin).toContain("Your findings from round 1");
      });

      it("treats the review as clear when every blocking finding is refuted, and notes them in the PR", async () => {
        const { driver, store, edits } = setup(
          [{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("CHANGES", "major") }, { role: "verifier", output: refuted }],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          reason:
            "waiting at review gate: reviews: code CHANGES (1 blocking); the verifier refuted all 1 blocking findings; capture and merge are not automated yet",
        });
        expect(store.listEvents(run.id).some((e) => e.from_state === "review" && e.to_state === "build")).toBe(false);
        expect(edits.at(-1)!.body).toContain(
          "**Refuted by the verifier**\n- code major: it says fixed (feature.txt:1)\n  Refuted: the check accepts exactly that",
        );
        expect(approveTarget(store.getRun(run.id)!)).toBe("capture");
      });

      it("gives the verifier no shell and only verify.md to write", async () => {
        const { driver, root } = setup(
          [{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: review("CHANGES", "major") }, { role: "verifier", output: refuted }],
          { config: codeOnly },
        );
        const run = driver.startRun(12);
        await driver.drive(run.id);

        const dir = runDirOf(root, run.id);
        const settings = JSON.parse(readFileSync(join(dir, "agent", "verifier.settings.json"), "utf8"));
        expect(settings.permissions.deny).toContain("Bash");
        expect(settings.permissions.allow).toEqual(["Read", "Grep", "Glob", `Edit(${absoluteRule(join(dir, "round-1", "verify.md"))})`]);
      });

      it("rejects a judgement that skips a finding, and escalates when the retry does too", async () => {
        const skips = "VERDICT: NONE_CONFIRMED\n\n## Summary\n- fine\n\n## Findings\n```json\n[]\n```\n";
        const { driver, fake } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: skips },
            { role: "verifier", output: skips },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          kind: "parked",
          reason: "verifier output was rejected twice: not judged (confirm or refute each): code-1",
        });
        expect(fake.calls().at(-1)!.stdin).toContain("- not judged (confirm or refute each): code-1");
      });

      it("after a usage limit, verifies again without rerunning the reviewers", async () => {
        const { driver, fake } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", stream: "rate_limited" },
            { role: "verifier", output: refuted },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({ kind: "rate_limited" });
        expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringContaining("the verifier refuted all 1 blocking findings") });
        expect(fake.calls().filter((c) => c.role === "reviewer-code")).toHaveLength(1);
      });

      it("stops at the review gate when the verifier confirms the same findings two rounds in a row", async () => {
        const { driver, store, edits } = setup(
          [
            { output: TRIAGE() },
            buildStep("fixed"),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
            rework(1),
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
          ],
          { config: codeOnly },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          kind: "parked",
          reason:
            "waiting at review gate: reviews: code CHANGES (1 blocking); stalled: the verifier confirmed the same findings in review rounds 1 and 2 (see round-1/verify.md and round-2/verify.md)",
        });
        const parked = store.getRun(run.id)!;
        expect(parked).toMatchObject({ state: "needs_human", parked_from: "review", waiting_gate: "review", review_rounds: 1 });
        // A human may approve it as is, and the PR lists what is still open.
        expect(approveTarget(parked)).toBe("capture");
        expect(store.listEvents(run.id).at(-1)!.data).toMatchObject({ stalled: "reviews", rounds: [1, 2] });
        expect(edits.at(-1)!.body).toContain("**Confirmed by the verifier, not fixed**\n- major: it says fixed (feature.txt:1)");
      });

      it("stops at the review round cap, naming the hard rules, and tells the builder the findings when a human sends it back", async () => {
        const config = `${codeOnly}loops:\n  max_review_rounds: 1\n`;
        const touchInfra: FakeStep = { ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "infra/main.tf": "x\n" } };
        const { driver, store, fake } = setup(
          [
            { output: TRIAGE() },
            touchInfra,
            { role: "reviewer-code", output: review("CHANGES", "major") },
            { role: "verifier", output: confirmed() },
            rework(1),
            { role: "reviewer-code", output: REVIEW_PASS },
          ],
          { config },
        );
        const run = driver.startRun(12);

        expect(await driver.drive(run.id)).toMatchObject({
          kind: "parked",
          reason:
            "waiting at review gate: reviews: code CHANGES (1 blocking); reviews still have confirmed findings after round 1: review round cap reached (1); hard rule: protected path (infra/**): infra/main.tf",
        });

        new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "one more try" });
        await driver.drive(run.id);
        const rebuilt = fake.calls().filter((c) => c.role === "builder")[1]!;
        expect(rebuilt.stdin).toContain("The reviewers of round 1 found problems, and a verifier confirmed these");
        expect(rebuilt.stdin).toContain("A human sent this back to you with this comment: one more try");
        expect(store.getRun(run.id)).toMatchObject({ round: 2, waiting_gate: "review" });
      });
    });

    it("after a usage limit, only runs the lenses that have no review yet", async () => {
      const { driver, fake } = setup([
        { output: TRIAGE() },
        buildStep("fixed"),
        { role: "reviewer-code", output: REVIEW_PASS },
        { role: "reviewer-docs", output: REVIEW_PASS },
        { role: "reviewer-security", stream: "rate_limited" },
        { role: "reviewer-security", output: REVIEW_PASS },
      ]);
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ kind: "rate_limited" });
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("reviews: code PASS, security PASS, docs PASS") });
      expect(fake.calls().slice(2).map((c) => c.role)).toHaveLength(4);
      expect(fake.calls().at(-1)!.role).toBe("reviewer-security");
    });

    it("approving the review gate moves on to capture", async () => {
      const { driver, store } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...reviewsPass()]);
      const run = driver.startRun(12);
      await driver.drive(run.id);

      const parked = store.getRun(run.id)!;
      expect(parked).toMatchObject({ waiting_gate: "review", parked_from: "review" });
      expect(approveTarget(parked)).toBe("capture");
      // A run parked at the review gate before reviews existed gets its reviews when approved.
      expect(approveTarget({ ...parked, parked_from: "gate" })).toBe("review");
    });

    it("reviews a run that was parked at the review gate before reviews existed, once approved", async () => {
      const { driver, store, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...reviewsPass(), ...reviewsPass()]);
      const run = driver.startRun(12);
      await driver.drive(run.id);
      // What the old driver left behind: parked straight from the quality gate, no reviews.
      store.writeState(run.id, "needs_human", { parked_from: "gate", waiting_gate: "review" });
      for (const lens of ["code", "security", "docs"]) rmSync(join(runDirOf(root, run.id), "round-1", `review-${lens}.md`));

      const parked = store.getRun(run.id)!;
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, approveTarget(parked)!, { comment: "approved" });
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("reviews: code PASS, security PASS, docs PASS") });
      expect(fake.calls().filter((c) => c.role!.startsWith("reviewer-"))).toHaveLength(6);
    });

    it("gives reviewers the change in a file, no shell, and only their own output file to write", async () => {
      const { driver, store, fake, root } = setup([{ output: TRIAGE() }, buildStep("fixed"), ...reviewsPass()]);
      const run = driver.startRun(12);
      await driver.drive(run.id);

      const dir = runDirOf(root, run.id);
      const change = readFileSync(join(dir, "round-1", "change.diff"), "utf8");
      expect(change).toContain("feat: fixed");
      expect(change).toContain("+fixed");
      const code = fake.calls().find((c) => c.role === "reviewer-code")!;
      expect(code.stdin).toContain(join(dir, "round-1", "change.diff"));
      const settings = JSON.parse(readFileSync(join(dir, "agent", "reviewer-code.settings.json"), "utf8"));
      expect(settings.permissions.deny).toContain("Bash");
      expect(settings.permissions.allow.filter((r: string) => r.startsWith("Edit"))).toEqual([`Edit(${absoluteRule(join(dir, "round-1", "review-code.md"))})`]);
      expect(store.getRun(run.id)!.state).toBe("needs_human");
    });

    it("names every reviewer that failed, keeps the others' reviews, and reruns only the failed ones", async () => {
      const failed: FakeStep = { stream: "error_max_turns" };
      const { driver, store, fake } = setup([
        { output: TRIAGE() },
        buildStep("fixed"),
        { role: "reviewer-code", output: REVIEW_PASS },
        { role: "reviewer-docs", ...failed },
        { role: "reviewer-security", ...failed },
        { role: "reviewer-docs", output: REVIEW_PASS },
        { role: "reviewer-security", output: REVIEW_PASS },
      ]);
      const run = driver.startRun(12);

      const outcome = await driver.drive(run.id);
      expect(outcome).toMatchObject({ kind: "parked", reason: expect.stringMatching(/^reviewer \(security\) agent failed .*; reviewer \(docs\) agent failed /) });

      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "review", { comment: "try again" });
      expect(await driver.drive(run.id)).toMatchObject({ reason: expect.stringContaining("reviews: code PASS, security PASS, docs PASS") });
      expect(fake.calls().filter((c) => c.role === "reviewer-code")).toHaveLength(1);
    });

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
    const { driver, store, fake } = setup([{ output: TRIAGE().replace("RISK: LOW", "RISK: HIGH") }, buildStep("fixed"), ...reviewsPass()], { config });
    const run = driver.startRun(12);

    await driver.drive(run.id);

    const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
    const [triage, builder] = fake.calls();
    expect([flag(triage!.argv, "--model"), flag(triage!.argv, "--effort")]).toEqual(["fable", "medium"]);
    expect([flag(builder!.argv, "--model"), flag(builder!.argv, "--effort")]).toEqual(["sonnet", "xhigh"]);
    expect(store.listAgentRuns(run.id).slice(0, 2).map((a) => [a.role, a.model, a.effort])).toEqual([
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
    const { driver, store, fake, root } = setup([{ output: TRIAGE() }, leaky, cleaned, ...reviewsPass()]);
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

  it("keeps looping on different failures until max_build_iterations, then escalates", async () => {
    const config =
      "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: always\nloops:\n  max_build_iterations: 3\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }, buildStep("broken 1"), buildStep("broken 2"), buildStep("broken 3")], { config });
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(outcome.kind === "parked" && outcome.reason).toMatch(/still failing after round 3.*cap reached \(3\)/);
    expect(store.getRun(run.id)!.build_iterations).toBe(2);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "builder", "builder", "builder"]);
  });

  it("escalates a gate that fails the same way twice in a row, before the cap", async () => {
    const config =
      "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: always\nloops:\n  max_build_iterations: 5\n";
    const { driver, store, fake } = setup([{ output: TRIAGE() }, sameFailure(1), sameFailure(2), sameFailure(3), sameFailure(4)], { config });
    const run = driver.startRun(12);

    const outcome = await driver.drive(run.id);

    expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
    expect(outcome.kind === "parked" && outcome.reason).toBe(
      "stalled: quality gate failed the same way in rounds 1 and 2 (see round-1/checks.md and round-2/checks.md)",
    );
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "builder", "builder"]);
    expect(store.getRun(run.id)).toMatchObject({ state: "needs_human", parked_from: "gate", build_iterations: 1 });

    // The loop event holds round 1's fingerprint; the escalation links both rounds to it.
    const events = store.listEvents(run.id);
    const loop = events.find((e) => e.from_state === "gate" && e.to_state === "build")!.data as { fingerprint: string; round: number };
    expect(loop).toMatchObject({ round: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(events.at(-1)!.data).toEqual({
      stalled: "quality gate",
      fingerprint: loop.fingerprint,
      rounds: [1, 2],
      files: ["round-1/checks.md", "round-2/checks.md"],
    });

    // A human grants another attempt: the next identical failure loops, the one after stalls again.
    // Rounds keep counting, so the earlier rounds' reports stay as they were.
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "build", { comment: "look at check.js" });
    const again = await driver.drive(run.id);

    expect(again.kind === "parked" && again.reason).toMatch(/^stalled: quality gate failed the same way in rounds 3 and 4 /);
    expect(fake.calls()[3]!.stdin).toContain("The quality gate failed in round 2. Its report:");
    expect(fake.calls()[3]!.stdin).toContain("A human sent this back to you with this comment: look at check.js");
    expect(fake.calls()).toHaveLength(5);
    expect(store.getRun(run.id)!.build_iterations).toBe(2);
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
  it("adds the review notes before the closing line", () => {
    expect(prBody("STATUS: READY\n\n## Summary\n- done\n", 3, false, "## Review notes\n- x\n")).toBe("## What\n- done\n\n## Review notes\n- x\n\nCloses #3\n");
  });
});

describe("verifier helpers", () => {
  const f = (id: string, severity: string, extra: object = {}) => ({ id, severity, claim: `claim ${id}`, evidence: "e", ...extra }) as Finding;
  const review = (findings: Finding[]) => ({
    header: { VERDICT: findings.some((x) => x.severity === "critical" || x.severity === "major") ? "CHANGES" : "PASS" },
    body: "",
    findings,
  }) as ParsedVerdict<"review">;
  const verify = (verdict: string, confirmed: Finding[], refuted: string[] = []) =>
    ({
      header: { VERDICT: verdict },
      body: `## Summary\n- x\n\n## Findings\n\n## Refuted\n${refuted.map((r) => `- ${r}`).join("\n")}\n`,
      findings: confirmed,
    }) as ParsedVerdict<"verify">;

  it("collects blocking findings, naming the lens when two lenses share an id", () => {
    const reviews: LensReview[] = [
      { lens: "code", verdict: review([f("x-1", "major"), f("code-2", "minor")]) },
      { lens: "security", verdict: review([f("x-1", "critical"), f("security-1", "major")]) },
    ];
    expect(blockingFindings(reviews).map((b) => `${b.lens}:${b.finding.id}`)).toEqual(["code:code/x-1", "security:security/x-1", "security:security-1"]);
  });

  it("reads refuted lines with or without backticks", () => {
    const body = "## Refuted\n- code-1: handled in a.ts:3\n* `security-2`: not reachable\nnot a line\n\n## Other\n- x: y\n";
    expect(refutedFindings(body)).toEqual([
      { id: "code-1", reason: "handled in a.ts:3" },
      { id: "security-2", reason: "not reachable" },
    ]);
    expect(refutedFindings("## Summary\n- x\n")).toEqual([]);
    // Ids may hold colons or spaces: the known ids are matched first, and nested bullets belong to the reason.
    const odd = "## Refuted\n- code:1: off by one is fine\n  - see a.ts\n- `my finding`: duplicate\n";
    expect(refutedFindings(odd, ["code", "code:1", "my finding"])).toEqual([
      { id: "code:1", reason: "off by one is fine" },
      { id: "my finding", reason: "duplicate" },
    ]);
  });

  it("wants every blocking finding judged exactly once, and only known ones", () => {
    const blocking: BlockingFinding[] = [
      { lens: "code", finding: f("code-1", "major") },
      { lens: "code", finding: f("code-2", "critical") },
    ];
    expect(verifyProblems(verify("CONFIRMED", [f("code-1", "major")], ["code-2: fine"]), blocking)).toEqual([]);
    // A finding of its own about an injection attempt is allowed.
    expect(verifyProblems(verify("CONFIRMED", [f("verifier-1", "critical")], ["code-1: no", "code-2: no"]), blocking)).toEqual([]);
    expect(verifyProblems(verify("CONFIRMED", [f("code-1", "major"), f("code-9", "major")], ["code-1: no"]), blocking)).toEqual([
      "confirmed finding code-9 is not one of the findings to verify",
      "judged more than once: code-1",
      "not judged (confirm or refute each): code-2",
    ]);
    expect(verifyProblems(verify("NONE_CONFIRMED", [f("code-1", "minor")], ["code-2: no", "code-7: no"]), blocking)).toEqual([
      "confirmed finding code-1 must be critical or major; refute it if it is only minor",
      "refuted finding code-7 is not one of the findings to verify",
    ]);
  });

  it("notes minor findings per lens and refuted findings with why, or nothing", () => {
    const reviews: LensReview[] = [
      { lens: "code", verdict: review([f("code-1", "major", { file: "a.ts", line: 3 }), f("code-2", "nit", { file: "b.ts" })]) },
      { lens: "docs", verdict: review([]) },
    ];
    expect(reviewNotes(reviews, verify("NONE_CONFIRMED", [], ["code-1: a.ts:2 guards it"]))).toBe(
      [
        "## Review notes",
        "Left for you to judge.",
        "",
        "**code**",
        "- nit: claim code-2 (b.ts)",
        "",
        "**Refuted by the verifier**",
        "- code major: claim code-1 (a.ts:3)",
        "  Refuted: a.ts:2 guards it",
      ].join("\n"),
    );
    expect(reviewNotes([{ lens: "docs", verdict: review([]) }])).toBeUndefined();
  });
});
