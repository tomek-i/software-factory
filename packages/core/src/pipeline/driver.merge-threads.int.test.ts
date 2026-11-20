import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVerdict } from "@factory/shared";
import { buildStep, review, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, REVIEW_PASS, type FakeStep } from "../../test/helpers.js";
import { approve, CODE_PASS, mergeConfig } from "../../test/merge-setup.js";
import type { ReviewThread } from "../github/port.js";
import { runDirOf } from "./driver.js";
import { noteMarker, type NoteMarker } from "./reviews.js";
import { ANSWER_MARKER } from "./threads.js";

/** One of the factory's own review notes on feature.txt:1, marked as `reviewNotes` marks them. */
const note = (id: string, text: string, marker?: NoteMarker): ReviewThread => ({
  id,
  author: "factory-bot",
  own: true,
  path: "feature.txt",
  line: 1,
  body: marker ? `${text}\n\n${noteMarker(marker)}` : text,
  url: `https://github.com/o/r/pull/7#discussion_${id}`,
  outdated: false,
  replies: [],
});
const NIT = note("T1", "**code** · nit: name it `total`", { kind: "note", round: 1, finding: "code-2" });
const REFUTED = note("T2", "**code** · major (refuted by the verifier): it says fixed\n\nRefuted: the check accepts exactly that", {
  kind: "refuted",
  round: 1,
  finding: "code-1",
});

/** The builder's answer to the notes, committing a change first when `commit` is set. */
const answers = (list: object[], commit = false): FakeStep => ({
  role: "builder",
  ...(commit
    ? {
        files: { "feature.txt": "fixed\n", "total.txt": "renamed\n" },
        exec: [
          ["git", "add", "-A"],
          ["git", "commit", "-qm", "refactor: name it total"],
        ],
      }
    : {}),
  output: `STATUS: DONE\nCOMMIT: ${commit ? "{{HEAD}}" : "none"}\n\n## Summary\n- answered\n\n## Threads\n\`\`\`json\n${JSON.stringify(list)}\n\`\`\`\n`,
});

const reply = (text: string) => `${text}\n\n${ANSWER_MARKER}`;

describe("PipelineDriver merge stage: the factory's own review threads", () => {
  it("answers a refuted finding with the verifier's reason and resolves it, without the builder", async () => {
    const { driver, pr, merges, replies, resolved, fake } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], { config: mergeConfig("merge: always") });
    pr.threads = [[REFUTED]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(replies).toEqual([{ thread: "T2", body: reply("Wrong: refuted by the verifier: the check accepts exactly that") }]);
    expect(resolved).toEqual(["T2"]);
    expect(merges).toHaveLength(1);
    expect(fake.calls().filter((c) => c.role === "builder")).toHaveLength(1);
  });

  it("answers a confirmed finding with the commit of the round that fixed it", async () => {
    const confirmed =
      'VERDICT: CONFIRMED\n\n## Summary\n- real\n\n## Findings\n```json\n[{ "id": "code-1", "severity": "major", "file": "feature.txt", "line": 1, "claim": "it says fixed", "evidence": "read line 1" }]\n```\n';
    const { driver, pr, merges, replies, resolved, root } = setup(
      [
        { output: TRIAGE() },
        buildStep("fixed"),
        { role: "reviewer-code", output: review("CHANGES", "major") },
        { role: "verifier", output: confirmed },
        { ...buildStep("fixed"), files: { "feature.txt": "fixed\n", "rework.txt": "1\n" } },
        { role: "reviewer-code", output: REVIEW_PASS },
      ],
      { config: mergeConfig("merge: always") },
    );
    pr.threads = [[note("T3", "**code** · major (confirmed by the verifier, not fixed): it says fixed", { kind: "confirmed", round: 1, finding: "code-1" })]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    // The round after the confirmed verdict starts with the build that fixed it.
    const fixedIn = parseVerdict("checks", readFileSync(join(runDirOf(root, run.id), "round-2", "checks.md"), "utf8")).header.COMMIT;
    expect(replies).toEqual([{ thread: "T3", body: reply(`Fixed in ${fixedIn.slice(0, 12)}`) }]);
    expect(resolved).toEqual(["T3"]);
    expect(merges).toHaveLength(1);
  });

  it("lets the builder fix a note: the commit goes through the gate and the push before the reply, and needs approving", async () => {
    const { driver, store, pr, prs, remote, merges, replies, resolved, root } = setup(
      [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, answers([{ id: "T1", outcome: "fixed", reason: "renamed it" }], true)],
      { config: mergeConfig("merge: human") },
    );
    pr.threads = [[NIT]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringMatching(/^waiting at merge gate: gate is set to human/) });
    const pushed = git(remote, "rev-parse", `refs/heads/${prs[0]!.head}`);
    expect(replies).toEqual([{ thread: "T1", body: reply(`Fixed in ${pushed.slice(0, 12)}: renamed it`) }]);
    expect(resolved).toEqual(["T1"]);
    // The quality gate ran again on the builder's commit, and the human is asked about that commit.
    const dir = runDirOf(root, run.id);
    expect(existsSync(join(dir, "round-1", "resync", "checks.md"))).toBe(true);
    expect(existsSync(join(dir, "round-1", "resync", "threads.md"))).toBe(true);
    expect(store.listEvents(run.id).at(-1)!.data).toMatchObject({ commit: pushed });

    approve(store, run.id);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(merges).toEqual([{ number: 7, head: pushed }]);
  });

  it("posts the builder's reason when it declines a note", async () => {
    const { driver, pr, merges, replies, resolved } = setup(
      [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, answers([{ id: "T1", outcome: "declined", reason: "the name matches the API" }])],
      { config: mergeConfig("merge: always") },
    );
    pr.threads = [[NIT]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(replies).toEqual([{ thread: "T1", body: reply("Declined: the name matches the API") }]);
    expect(resolved).toEqual(["T1"]);
    expect(merges).toHaveLength(1);
  });

  it("opens a follow-up issue for a deferred note, links it in the reply, and leaves it unqueued by default", async () => {
    const { driver, store, project, pr, replies, resolved, issues } = setup(
      [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, answers([{ id: "T1", outcome: "deferred", reason: "it touches every caller", title: "Rename the counter to total" }])],
      { config: mergeConfig("merge: always") },
    );
    pr.threads = [[NIT]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(issues).toEqual([
      {
        number: 50,
        title: "Rename the counter to total",
        body: expect.stringContaining("A review note on #7, deferred before the merge: https://github.com/o/r/pull/7#discussion_T1\n\n> **code** · nit: name it `total`\n\nWhy it was deferred: it touches every caller"),
      },
    ]);
    expect(issues[0]!.body).not.toContain("factory:note");
    expect(replies).toEqual([{ thread: "T1", body: reply("Deferred to #50: it touches every caller") }]);
    expect(resolved).toEqual(["T1"]);
    expect(store.getIssue(project.id, 50)).toBeUndefined();
  });

  it("queues the follow-up issue as the factory's own with merge.queue_followups", async () => {
    const { driver, store, project, pr } = setup(
      [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, answers([{ id: "T1", outcome: "deferred", reason: "later", title: "Rename the counter" }])],
      { config: mergeConfig("merge: always", "merge:\n  queue_followups: true\n") },
    );
    pr.threads = [[NIT]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(store.getIssue(project.id, 50)).toMatchObject({ title: "Rename the counter", state: "open", created_by_factory: true, queued_at: expect.any(String) });
  });

  it("only says a note was deferred with merge.followup_issues off", async () => {
    const { driver, pr, replies, issues } = setup(
      [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, answers([{ id: "T1", outcome: "deferred", reason: "later", title: "Rename the counter" }])],
      { config: mergeConfig("merge: always", "merge:\n  followup_issues: false\n") },
    );
    pr.threads = [[NIT]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(issues).toEqual([]);
    expect(replies).toEqual([{ thread: "T1", body: reply("Deferred: later") }]);
  });

  it("holds the merge for a human when a thread cannot be resolved, even with open_feedback ignore, and retries without a second reply", async () => {
    const { driver, store, pr, merges, replies, resolved, seen } = setup([{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS], {
      config: mergeConfig("merge: always", "merge:\n  open_feedback: ignore\n"),
    });
    pr.threads = [[REFUTED]];
    pr.resolveErrors = ["Resource not accessible by integration"];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({
      kind: "parked",
      reason: "waiting at merge gate: unresolved review thread by the factory at feature.txt:1 (https://github.com/o/r/pull/7#discussion_T2)",
    });
    expect(merges).toEqual([]);
    expect(seen.some((e) => e.type === "info" && e.message.includes("could not answer review thread https://github.com/o/r/pull/7#discussion_T2: Resource not accessible"))).toBe(true);

    // Approving does not merge past it: the next attempt resolves it, replying only once.
    approve(store, run.id);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(replies).toHaveLength(1);
    expect(resolved).toEqual(["T2"]);
    expect(merges).toHaveLength(1);
  });

  it("opens one follow-up issue when a reply failed after it, and posts the reply on the retry", async () => {
    const { driver, store, pr, github, merges, replies, issues } = setup(
      [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, answers([{ id: "T1", outcome: "deferred", reason: "later", title: "Rename the counter" }])],
      { config: mergeConfig("merge: always") },
    );
    pr.threads = [[NIT]];
    const post = github.replyToReviewThread;
    let failures = 1;
    github.replyToReviewThread = (thread, body) => {
      if (failures-- > 0) throw new Error("HTTP 502");
      post(thread, body);
    };
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: expect.stringContaining("unresolved review thread by the factory") });
    expect(issues).toHaveLength(1);
    expect(replies).toEqual([]);

    approve(store, run.id);
    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(issues).toHaveLength(1);
    expect(replies).toEqual([{ thread: "T1", body: reply("Deferred to #50: later") }]);
    expect(merges).toHaveLength(1);
  });

  it("asks the builder about a note posted before notes were marked", async () => {
    const { driver, pr, replies, fake } = setup(
      [{ output: TRIAGE() }, buildStep("fixed"), CODE_PASS, answers([{ id: "T4", outcome: "declined", reason: "already handled" }])],
      { config: mergeConfig("merge: always") },
    );
    pr.threads = [[note("T4", "**docs** · minor: mention the flag in the README")]];
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "done" });
    expect(replies).toEqual([{ thread: "T4", body: reply("Declined: already handled") }]);
    const asked = fake.calls().filter((c) => c.role === "builder")[1]!;
    expect(asked.stdin).toMatch(/<<<NOTES [0-9a-f]{12}>>>\n### Thread T4 at feature.txt:1\n\n\*\*docs\*\* · minor: mention the flag in the README\n/);
  });
});
