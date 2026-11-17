import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema, parseVerdict } from "@factory/shared";
import { buildStep, CODE_PASS, lastMove, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, REVIEW_PASS, type FakeStep } from "../../test/helpers.js";
import { absoluteRule } from "../agents/prompts.js";
import { readAcceptanceRecord } from "./acceptance.js";
import { approveTarget, REFINE_MARKER, runDirOf, waitingCommit } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const config = (gates: string) =>
  `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n${gates}reviews:\n  always: [code]\n  ui: []\n`;
const reviewHuman = config("  review: human\n");

// CRLF, as GitHub returns issue bodies; an unrelated checkbox outside the criteria; one ticked already.
const ISSUE = [
  "Please add feature.txt.",
  "",
  "- [ ] not a criterion: outside the heading",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] feature.txt says fixed",
  "* [ ] it is checked in a browser at 390px",
  "- [x] the README is unchanged",
  "",
  "## Notes",
  "- [ ] not a criterion either",
].join("\r\n");

const answer = (verdict: string, criteria: object[]) =>
  `VERDICT: ${verdict}\n\n## Summary\n- checked\n\n## Criteria\n\`\`\`json\n${JSON.stringify(criteria, null, 2)}\n\`\`\`\n`;
const acceptance = (verdict: string, criteria: object[]): FakeStep => ({ role: "reviewer-acceptance", output: answer(verdict, criteria) });
const MET = (id: string) => ({ id, status: "MET", evidence: "check.js:3 reads feature.txt" });
const NOT_MET = (id: string) => ({ id, status: "NOT_MET", evidence: "feature.txt still says broken" });
const confirmed = (id: string) =>
  `VERDICT: CONFIRMED\n\n## Summary\n- real\n\n## Findings\n\`\`\`json\n[{ "id": "${id}", "severity": "major", "claim": "not met", "evidence": "read feature.txt" }]\n\`\`\`\n`;
const refuted = (id: string) => `VERDICT: NONE_CONFIRMED\n\n## Summary\n- not real\n\n## Findings\n\`\`\`json\n[]\n\`\`\`\n\n## Refuted\n- ${id}: feature.txt says fixed\n`;
const rework: FakeStep = { ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "rework.txt": "1\n" } };

describe("PipelineDriver acceptance lens", () => {
  it("checks the engine's numbered criteria, lists the ones a human must check, and ticks only MET ones after the merge", async () => {
    const { driver, store, fake, root, edits, issueBody } = setup(
      [
        { output: TRIAGE() },
        buildStep("fixed"),
        CODE_PASS,
        // AC-2 needs a browser; AC-3 is not answered; AC-9 is not one of the criteria.
        acceptance("PASS", [MET("AC-1"), { id: "AC-2", status: "CANNOT_CHECK", evidence: "needs a browser" }, MET("AC-9")]),
      ],
      { config: config("  merge: human\n"), issueBody: ISSUE, ownIssue: true },
    );
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({
      kind: "parked",
      reason: expect.stringContaining(
        "acceptance criteria for you to check: AC-2 it is checked in a browser at 390px; AC-3 the README is unchanged",
      ),
    });
    expect(store.getRun(run.id)).toMatchObject({ waiting_gate: "merge" });

    // The agent got exactly the engine's list, as data, with no shell and only its own file to write.
    const dir = runDirOf(root, run.id);
    const agent = fake.calls().find((c) => c.role === "reviewer-acceptance")!;
    expect(agent.stdin).toContain("## Acceptance criteria to check");
    expect(agent.stdin).toContain('"id": "AC-1",\n    "from": "issue",\n    "criterion": "feature.txt says fixed"');
    expect(agent.stdin).toContain('"id": "AC-3"');
    const list = agent.stdin.slice(agent.stdin.indexOf("## Acceptance criteria to check"), agent.stdin.indexOf("## Now"));
    expect(list).not.toContain('"id": "AC-4"');
    expect(list).not.toContain("not a criterion");
    const settings = JSON.parse(readFileSync(join(dir, "agent", "reviewer-acceptance.settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Bash");
    expect(settings.permissions.allow.filter((r: string) => r.startsWith("Edit"))).toEqual([`Edit(${absoluteRule(join(dir, "round-1", "acceptance.md"))})`]);

    expect(readAcceptanceRecord(join(dir, "round-1"))!.criteria.map((c) => `${c.id} ${c.status}`)).toEqual(["AC-1 MET", "AC-2 CANNOT_CHECK", "AC-3 NOT_CHECKED"]);
    expect(parseVerdict("review", readFileSync(join(dir, "round-1", "review-acceptance.md"), "utf8")).header.VERDICT).toBe("PASS");
    expect(lastMove(store, run.id).reason).not.toContain("AC-9");

    // The PR description has the checklist with status, evidence and the count line, once.
    const body = edits.at(-1)!.body;
    expect(body).toContain(
      [
        "## Acceptance criteria",
        "1/1 met, 2 for you to check.",
        "",
        "- [x] AC-1: feature.txt says fixed",
        "  met: check.js:3 reads feature.txt",
        "- [ ] AC-2: it is checked in a browser at 390px",
        "  for you to check: needs a browser",
        "- [ ] AC-3: the README is unchanged",
        "  not checked, for you to check",
      ].join("\n"),
    );
    expect(body.match(/## Acceptance criteria/g)).toHaveLength(1);

    // Nothing is ticked before the merge.
    expect(issueBody.edits).toBe(0);

    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, approveTarget(store.getRun(run.id)!, "build")!, {
      comment: "checked in a browser",
      commitSha: waitingCommit(store.listEvents(run.id)),
    });
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });

    // Only AC-1's box changed, byte for byte; AC-3 was ticked already and the boxes outside the heading stay.
    expect(issueBody.edits).toBe(1);
    expect(issueBody.text).toBe(ISSUE.replace("- [ ] feature.txt says fixed", "- [x] feature.txt says fixed"));
  });

  it("sends a NOT_MET criterion back to the builder once the verifier confirms it", async () => {
    const { driver, store, fake } = setup(
      [
        { output: TRIAGE() },
        buildStep("fixed"),
        CODE_PASS,
        acceptance("CHANGES", [NOT_MET("AC-1"), MET("AC-2"), MET("AC-3")]),
        { role: "verifier", output: confirmed("acceptance-AC-1") },
        rework,
        CODE_PASS,
        acceptance("PASS", [MET("AC-1"), MET("AC-2"), MET("AC-3")]),
      ],
      { config: reviewHuman, issueBody: ISSUE },
    );
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS, acceptance PASS (3/3 met); gate is set to human" });
    const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
    expect(moves).toContain("review>build");
    expect(store.getRun(run.id)).toMatchObject({ round: 2, review_rounds: 1 });
    const calls = fake.calls();
    expect(calls.find((c) => c.role === "verifier")!.stdin).toContain('"id": "acceptance-AC-1"');
    const rebuilt = calls.filter((c) => c.role === "builder")[1]!;
    expect(rebuilt.stdin).toContain('"id": "acceptance-AC-1"');
  });

  it("does not block on a NOT_MET criterion the verifier refutes, and notes the refutation", async () => {
    const { driver, store, edits, reviews } = setup(
      [
        { output: TRIAGE() },
        buildStep("fixed"),
        CODE_PASS,
        acceptance("CHANGES", [NOT_MET("AC-1"), MET("AC-2"), MET("AC-3")]),
        { role: "verifier", output: refuted("acceptance-AC-1") },
      ],
      { config: reviewHuman, issueBody: ISSUE },
    );
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({
      reason:
        "waiting at review gate: reviews: code PASS, acceptance CHANGES (2/3 met); the verifier refuted all 1 blocking findings; gate is set to human",
    });
    expect(store.listEvents(run.id).some((e) => e.from_state === "review" && e.to_state === "build")).toBe(false);
    const body = edits.at(-1)!.body;
    expect(body).toContain("- [ ] AC-1: feature.txt says fixed\n  not met: feature.txt still says broken");
    // The refutation is a review note: on the PR as a review, not in the description.
    expect(body).not.toContain("Refuted");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body).toContain("- acceptance major: AC-1 is not met: feature.txt says fixed\n  Refuted: feature.txt says fixed");
  });

  it("treats malformed output like any other invalid review", async () => {
    const broken: FakeStep = { role: "reviewer-acceptance", output: "VERDICT: PASS\n\n## Criteria\n```json\n[{ \"id\": \"AC-1\", \"status\": \"MET\" }]\n```\n" };
    const { driver, store } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, broken, broken], { config: reviewHuman, issueBody: ISSUE });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("reviewer (acceptance) output was rejected twice") });
    expect(store.getRun(run.id)!.waiting_gate).toBeNull();
  });

  it("skips the agent for an issue without checkbox criteria and passes with no criteria", async () => {
    const { driver, fake, root, edits } = setup([{ output: TRIAGE() }, buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], { config: reviewHuman });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ reason: "waiting at review gate: reviews: code PASS; gate is set to human" });
    expect(fake.calls().map((c) => c.role)).not.toContain("reviewer-acceptance");
    const dir = runDirOf(root, run.id);
    const review = parseVerdict("review", readFileSync(join(dir, "round-1", "review-acceptance.md"), "utf8"));
    expect(review).toMatchObject({ header: { VERDICT: "PASS" }, summary: ["Acceptance criteria: no criteria"], findings: [] });
    expect(readAcceptanceRecord(join(dir, "round-1"))).toEqual({ criteria: [] });
    expect(existsSync(join(dir, "round-1", "acceptance.md"))).toBe(false);
    expect(edits.every((e) => !e.body.includes("Acceptance criteria"))).toBe(true);
  });

  it("checks the refine spec's criteria too, ticks them in the refine comment, and never edits another author's issue", async () => {
    const INCOMPLETE = TRIAGE().replace("READINESS: READY", "READINESS: INCOMPLETE");
    const spec =
      "STATUS: REFINED\n\n## Summary\n- spec\n\n## Acceptance criteria\n- [ ] feature.txt is one line, as @bob asked\n- [ ] it works offline\n\n## Scope\n- add feature.txt\n";
    const { driver, fake, comments, issueBody } = setup(
      [
        { output: INCOMPLETE },
        { role: "refine", output: spec },
        { role: "critic", output: "VERDICT: ACCEPT\n\n## Summary\n- holds\n" },
        buildStep("fixed"),
        CODE_PASS,
        acceptance("PASS", [MET("AC-1"), MET("AC-2"), MET("AC-3"), MET("AC-4"), { id: "AC-5", status: "CANNOT_CHECK", evidence: "needs a network switch" }]),
      ],
      { config: config("  critic: auto\n  merge: always\n"), issueBody: ISSUE, ownIssue: false },
    );
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });

    // The issue's three criteria come first, then the spec's, as posted (mention quoted).
    const agent = fake.calls().find((c) => c.role === "reviewer-acceptance")!;
    expect(agent.stdin).toContain('"id": "AC-4",\n    "from": "spec",\n    "criterion": "feature.txt is one line, as `@bob` asked"');
    expect(agent.stdin).toContain('"id": "AC-5"');
    // alice wrote the issue, so its body is left alone; only the refine comment is ticked.
    expect(issueBody.edits).toBe(0);
    const refine = comments.find((c) => c.body.startsWith(REFINE_MARKER))!;
    expect(refine.edits).toBe(1);
    expect(refine.body).toContain("- [x] feature.txt is one line, as `@bob` asked\n- [ ] it works offline\n");
  });
});
