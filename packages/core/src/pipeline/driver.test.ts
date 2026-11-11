import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseVerdict } from "@factory/shared";
import { buildStep, FAKE_AWS_KEY, READY, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, reviewsPass, type FakeStep } from "../../test/helpers.js";
import { prBody, runDirOf } from "./driver.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

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
