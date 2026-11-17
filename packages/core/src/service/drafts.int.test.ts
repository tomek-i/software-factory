import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import { loadConfig } from "../config/load.js";
import { DRAFTS_DIR } from "../drafts/writer.js";
import { FactoryEvents } from "../events.js";
import type { IssueWriterPort } from "../github/port.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { approveDraft, discardPendingDraft, draftIssue, ensureDraftsIgnored, pendingDrafts, saveDraft } from "./drafts.js";
import { ServiceError } from "./errors.js";
import type { ServiceContext } from "./runs.js";

// Each test drives a real git repo and a fake claude process; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

/** The fake GitHub's labels, with a status label the issue writer must never be offered. */
const REPO_LABELS = [
  { name: "ui", description: "Visible changes" },
  { name: "bug", description: "" },
  { name: "factory", description: "Queued in the software factory" },
];
const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.\n";
const SINGLE = `DECISION: PROCEED\n\n## Summary\n- drafted\n\n=== ISSUE ===\nTITLE: Add CSV export\nUI: NO\nRISK: LOW\n\n${SECTIONS}`;

/** A repo whose default branch sets `gates.issue_writer`, and a fake GitHub that numbers issues from 20. */
function context(steps: FakeStep[], gate: string) {
  const s = setup(steps, { config: `version: 1\ntrust:\n  authors: [alice]\ngates:\n  issue_writer: ${gate}\n` });
  const ctx: ServiceContext = { store: s.store, project: s.project, config: loadConfig(s.root) };
  const created: { number: number; title: string; body: string; labels?: string[] }[] = [];
  const github: IssueWriterPort = {
    createIssue: ({ title, body, labels }) => {
      created.push({ number: 20 + created.length, title, body, labels });
      return created.at(-1)!.number;
    },
    listLabels: () => REPO_LABELS,
    addSubIssue: () => undefined,
  };
  // `gh issue view` answers for the issues the fake GitHub created; git runs for real.
  const run: CommandRunner = (cmd, args, options) => {
    if (cmd !== "gh") return runCommand(cmd, args, options);
    const issue = created.find((c) => c.number === Number(args[2]));
    if (args[1] !== "view" || !issue) return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    const json = { ...issue, state: "OPEN", author: { login: "factory-operator" }, labels: [], url: "u", updatedAt: "2026-11-01T00:00:00Z" };
    return { code: 0, stdout: JSON.stringify(json), stderr: "" };
  };
  return { ...s, ctx, created, deps: { run, github, env: s.fake.env } };
}

describe("drafts", () => {
  it("leaves a draft waiting when the gate wants a human, then creates it on approval", async () => {
    const { ctx, root, created, deps } = context([{ role: "issue_writer", output: SINGLE }], "human");
    expect(ensureDraftsIgnored(ctx)).toEqual([".factory/drafts/"]);
    expect(ensureDraftsIgnored(ctx)).toEqual([]);

    const outcome = await draftIssue(ctx, "export the table as CSV", deps);

    expect(outcome).toMatchObject({ kind: "waiting", text: SINGLE, reasons: [expect.stringContaining("human")] });
    if (outcome.kind !== "waiting") return;
    expect(outcome.file).toBe(join(root, DRAFTS_DIR, outcome.id, "draft.md"));
    expect(pendingDrafts(ctx, deps.run).map((d) => d.id)).toEqual([outcome.id]);
    expect(created).toEqual([]);

    const shown: string[] = [];
    const published = approveDraft(ctx, outcome.id.slice(0, 9), { ...deps, onCreate: (text) => shown.push(text) });

    expect(shown).toEqual([SINGLE]);
    expect(published).toEqual({ id: outcome.id, issue: { number: 20, title: "Add CSV export" }, subIssues: [], buildable: [20], queued: [] });
    expect(ctx.store.getIssue(ctx.project.id, 20)!.queued_at).toBeNull();
    expect(pendingDrafts(ctx, deps.run)).toEqual([]);
  });

  it("says a draft is ready when the gate lets it through, and creates nothing itself", async () => {
    const { ctx, created, deps } = context([{ role: "issue_writer", output: SINGLE }], "always");

    const outcome = await draftIssue(ctx, "export the table as CSV", deps);

    expect(outcome).toEqual({ kind: "ready", id: expect.stringMatching(/^draft-[0-9a-f]{8}$/) });
    expect(created).toEqual([]);
    expect(approveDraft(ctx, outcome.id, { ...deps, queue: true })).toMatchObject({ issue: { number: 20, title: "Add CSV export" }, queued: [20] });
    expect(created.map((c) => c.title)).toEqual(["Add CSV export"]);
    expect(ctx.store.getIssue(ctx.project.id, 20)!.queued_at).not.toBeNull();
  });

  it("offers the repository's labels without the status labels, and opens the issue with the ones picked", async () => {
    const labelled = SINGLE.replace("RISK: LOW", "RISK: LOW\nLABELS: ui");
    const { ctx, created, deps, fake } = context([{ role: "issue_writer", output: labelled }], "always");

    const outcome = await draftIssue(ctx, "export the table as CSV", deps);
    const task = fake.calls()[0]!.stdin;
    expect(task).toContain('"name": "bug"');
    expect(task).not.toContain('"name": "factory"');
    approveDraft(ctx, outcome.id, deps);
    expect(created[0]!.labels).toEqual(["ui"]);
  });

  it("drafts without labels, and says why, when the repository's labels cannot be read", async () => {
    const { ctx, deps, fake } = context([{ role: "issue_writer", output: SINGLE }], "always");
    deps.github.listLabels = () => {
      throw new Error("gh label list failed: HTTP 502");
    };
    const events = new FactoryEvents();
    const seen: string[] = [];
    events.on((e) => {
      if (e.type === "info") seen.push(`${e.runId}: ${e.message}`);
    });
    let started = "";

    const outcome = await draftIssue(ctx, "export the table as CSV", { ...deps, events, onStart: (id) => (started = id) });

    expect(outcome.kind).toBe("ready");
    expect(fake.calls()[0]!.stdin).toContain("The repository's labels could not be read. Leave LABELS out.");
    expect(seen).toEqual([`${started}: Could not read the repository's labels, so the draft gets none: gh label list failed: HTTP 502`]);
  });

  it("says what to do when the issue writer's draft is invalid, and discards it", async () => {
    const { ctx, deps } = context([{ output: "not a draft\n" }, { output: "still not\n" }], "human");

    const error = await draftIssue(ctx, "an idea", deps).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ServiceError);
    expect((error as Error).message).toMatch(/^The issue writer's draft was rejected twice:\n- /);
    const [draft] = pendingDrafts(ctx, deps.run);
    expect(() => approveDraft(ctx, draft!.id, deps)).toThrow(new RegExp(`^Draft ${draft!.id} is not valid:\n- `));

    expect(discardPendingDraft(ctx, draft!.id, deps.run).id).toBe(draft!.id);
    expect(existsSync(draft!.dir)).toBe(false);
    expect(() => discardPendingDraft(ctx, draft!.id, deps.run)).toThrow(new ServiceError(`No pending draft "${draft!.id}". See \`factory new --list\`.`));
    expect(readFileSync(join(ctx.project.repo_path, ".gitignore"), "utf8")).not.toContain(".factory/drafts/");
  });
});

describe("saving an edited draft", () => {
  const edit = (title: string, body = SECTIONS) => ({ issue: { title, ui: true, risk: "medium", body }, subIssues: [] });

  it("tells the draft's id before the agent finishes, then saves a valid edit keeping the decision and summary", async () => {
    const { ctx, deps } = context([{ output: SINGLE }], "human");
    const started: string[] = [];

    const outcome = await draftIssue(ctx, "an idea", { ...deps, onStart: (id) => started.push(id) });

    expect(started).toEqual([outcome.id]);
    const saved = saveDraft(ctx, outcome.id, edit("Export orders as CSV"), deps.run);
    expect(saved.draft).toMatchObject({ decision: "PROCEED", summary: ["drafted"], issue: { title: "Export orders as CSV", ui: true, risk: "MEDIUM" } });
    const [entry] = pendingDrafts(ctx, deps.run);
    expect(entry!.draft).toEqual(saved.draft);
    expect(readFileSync(entry!.file, "utf8")).toContain("=== ISSUE ===\nTITLE: Export orders as CSV\nUI: YES\nRISK: MEDIUM\n");
  });

  it("refuses a broken edit with the problems approval reports, and leaves the file as it was", async () => {
    const { ctx, deps } = context([{ output: SINGLE }], "human");
    const { id } = await draftIssue(ctx, "an idea", deps);
    const [entry] = pendingDrafts(ctx, deps.run);

    expect(() => saveDraft(ctx, id, edit("T", SECTIONS.replace("## Acceptance criteria\n- [ ] it works\n", "")), deps.run)).toThrow(
      new ServiceError(`Draft ${id} is not valid:\n- issue: section ## Acceptance criteria is missing\nNothing was saved. Fix it and save it again, or discard it.`),
    );
    const sub = { title: "Only one", ui: false, risk: "LOW", body: SECTIONS };
    expect(() => saveDraft(ctx, id, { issue: edit("T").issue, subIssues: [sub] }, deps.run)).toThrow(
      /- a parent issue needs at least two sub-issues; write a single issue instead/,
    );
    expect(() => saveDraft(ctx, id, edit("Two\nTITLE: lines", `${SECTIONS}\n=== SUB-ISSUE ===\n`), deps.run)).toThrow(
      /- issue: TITLE must be one line\n- issue: the body may not hold a "=== SUB-ISSUE ===" line\n/,
    );
    expect(readFileSync(entry!.file, "utf8")).toBe(SINGLE);
  });

  it("refuses to save a draft git tracks, or one that does not parse", async () => {
    const { ctx, root, deps } = context([{ output: SINGLE }], "human");
    const { id } = await draftIssue(ctx, "an idea", deps);
    runCommand("git", ["add", "-f", join(DRAFTS_DIR, id, "draft.md")], { cwd: root });
    expect(() => saveDraft(ctx, id, edit("T"), deps.run)).toThrow(/^Draft draft-[0-9a-f]{8} cannot be saved: .*draft\.md is tracked by git/);

    const broken = context([{ output: "nope\n" }, { output: "nope\n" }], "human");
    await draftIssue(broken.ctx, "an idea", broken.deps).catch(() => undefined);
    const [entry] = pendingDrafts(broken.ctx, broken.deps.run);
    expect(() => saveDraft(broken.ctx, entry!.id, edit("T"), broken.deps.run)).toThrow(/does not parse, so it has no fields to edit/);
    expect(() => saveDraft(broken.ctx, "../x", edit("T"), broken.deps.run)).toThrow(/No pending draft "\.\.\/x"/);
  });
});
