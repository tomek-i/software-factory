import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema, VerdictParseError } from "@factory/shared";
import { fakeClaude, tempDir, type FakeStep } from "../../test/helpers.js";
import { createAgentRunner } from "../agents/runner.js";
import type { IssueWriterPort } from "../github/port.js";
import { Store } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { discardDraft, DRAFTS_DIR, findDraft, listDrafts, publishDraft, writeDraft } from "./writer.js";

const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.\n";
const block = (title: string, header = "UI: NO\nRISK: LOW", sub = false) =>
  `${sub ? "=== SUB-ISSUE ===" : "=== ISSUE ==="}\nTITLE: ${title}\n${header}\n\n${SECTIONS}`;
const SINGLE = `DECISION: PROCEED\n\n## Summary\n- one issue\n\n${block("Add CSV export")}`;
const PARENT = `DECISION: PROCEED\n\n## Summary\n- split\n\n${block("Exports")}${block("CSV", undefined, true)}${block("Excel", "UI: YES\nRISK: LOW\nDEPENDS_ON: 1", true)}`;

/** A draft folder as the issue writer leaves it. */
function draftFolder(root: string, id: string, text: string | undefined, idea = "an idea"): string {
  const dir = join(root, DRAFTS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "idea.md"), `${idea}\n`);
  if (text !== undefined) writeFileSync(join(dir, "draft.md"), text);
  return dir;
}

/** GitHub as far as publishing needs it: numbers from 20 up, `gh issue view` answers as alice. */
function fakeGithub(options: { failCreateAt?: number } = {}) {
  // Mutable, so a test can let GitHub recover.
  const state = { ...options };
  const created: { number: number; title: string; body: string }[] = [];
  const links: [number, number][] = [];
  let next = 20;
  const github: IssueWriterPort = {
    createIssue: ({ title, body }) => {
      if (created.length + 1 === state.failCreateAt) throw new Error("GitHub is down");
      created.push({ number: next, title, body });
      return next++;
    },
    addSubIssue: (parent, child) => links.push([parent, child]),
  };
  const run: CommandRunner = (_cmd, args) => {
    const number = Number(args[2]);
    const issue = created.find((c) => c.number === number)!;
    const json = { number, title: issue.title, body: issue.body, state: "OPEN", author: { login: "someone" }, labels: [], url: `https://github.com/o/r/issues/${number}`, updatedAt: "2026-11-01T00:00:00Z" };
    return { code: 0, stdout: JSON.stringify(json), stderr: "" };
  };
  return { github, run, created, links, state };
}

function storeFor(root: string) {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  return { store, project };
}

describe("writeDraft", () => {
  const config = factoryConfigSchema.parse({ version: 1, models: { roles: { issue_writer: "sonnet" } } });
  const write = (steps: FakeStep[], root = tempDir()) => {
    const fake = fakeClaude(steps);
    const read = (path: string) => (path === ".factory/lessons.md" ? "Keep issues small.\n" : undefined);
    return { fake, root, result: writeDraft({ root, config, read, runAgent: createAgentRunner({ env: fake.env }), idea: "  Export orders as CSV  " }) };
  };

  it("runs the issue writer on the idea in a new draft folder, with no shell and only its draft to write", async () => {
    const { fake, root, result } = write([{ role: "issue_writer", output: SINGLE }]);
    const draft = await result;

    expect(draft.turn.status).toBe("ok");
    expect(draft.id).toMatch(/^draft-[0-9a-f]{8}$/);
    expect(draft.dir).toBe(join(root, DRAFTS_DIR, draft.id));
    expect(readFileSync(join(draft.dir, "idea.md"), "utf8")).toBe("Export orders as CSV\n");
    const settings = JSON.parse(readFileSync(join(draft.dir, "agent", "issue_writer.settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Bash");
    expect(settings.permissions.allow).toHaveLength(4);

    const [call] = fake.calls();
    expect(call!.role).toBe("issue_writer");
    expect(call!.cwd).toBe(root);
    expect(call!.argv).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(call!.stdin).toContain("## Idea\nFrom the factory's operator, a trusted author.");
    expect(call!.stdin).toContain("Export orders as CSV");
    expect(call!.stdin).toContain("Keep issues small.");
    expect(listDrafts(root).map((d) => d.draft?.issue.title)).toEqual(["Add CSV export"]);
  });

  it("gives a malformed draft one retry with the problems", async () => {
    const { fake, result } = write([{ output: "DECISION: PROCEED\n\nno issue here\n" }, { output: SINGLE }]);
    expect((await result).turn.status).toBe("ok");
    expect(fake.calls()[1]!.stdin).toContain('the draft needs exactly one "=== ISSUE ===" line');
  });

  it("reports a draft that is still malformed after the retry", async () => {
    const { result } = write([{ output: "DECISION: PROCEED\n" }, { output: "DECISION: PROCEED\n" }]);
    expect((await result).turn).toMatchObject({ status: "invalid", problems: ['the draft needs exactly one "=== ISSUE ===" line (found 0)'] });
  });
});

describe("drafts", () => {
  it("lists pending drafts with their problems, finds them by prefix and discards them", () => {
    const root = tempDir();
    draftFolder(root, "draft-aaaa1111", SINGLE, "first");
    draftFolder(root, "draft-aaaa2222", "DECISION: PROCEED\n", "second");
    draftFolder(root, "draft-bbbb3333", undefined, "third");

    const drafts = listDrafts(root);
    expect(drafts.map((d) => [d.id, d.idea, d.problems.length > 0])).toEqual(
      expect.arrayContaining([
        ["draft-aaaa1111", "first", false],
        ["draft-aaaa2222", "second", true],
        ["draft-bbbb3333", "third", true],
      ]),
    );
    expect(drafts.find((d) => d.id === "draft-bbbb3333")!.problems).toEqual(["the issue writer did not write a draft"]);

    expect(findDraft(root, "draft-b").id).toBe("draft-bbbb3333");
    expect(() => findDraft(root, "draft-aaaa")).toThrow(/matches several drafts/);
    expect(() => findDraft(root, "../draft-aaaa1111")).toThrow(/No pending draft/);

    const dropped = discardDraft(root, "draft-aaaa2222");
    expect(existsSync(dropped.dir)).toBe(false);
    expect(listDrafts(root)).toHaveLength(2);
    expect(listDrafts(tempDir())).toEqual([]);
  });
});

describe("publishDraft", () => {
  it("creates a single issue, syncs it as created by the factory and queues it", () => {
    const root = tempDir();
    draftFolder(root, "draft-11112222", SINGLE);
    const { store, project } = storeFor(root);
    const { github, run, created, links } = fakeGithub();

    const published = publishDraft({ root, store, project, github, run, ref: "draft-1111" });

    expect(published).toEqual({ id: "draft-11112222", issue: { number: 20, title: "Add CSV export" }, subIssues: [], queued: [20] });
    expect(created[0]!.body).toBe(`${SECTIONS.trim()}\n\n---\n\n**UI change:** no · **Risk:** low\n`);
    expect(links).toEqual([]);
    expect(store.getIssue(project.id, 20)).toMatchObject({ author: "someone", created_by_factory: true });
    expect(store.getIssue(project.id, 20)!.queued_at).not.toBeNull();
    // Created drafts are no longer pending.
    expect(listDrafts(root)).toEqual([]);
    expect(() => publishDraft({ root, store, project, github, run, ref: "draft-11112222" })).toThrow(/No pending draft/);
  });

  it("creates a parent and linked sub-issues in order, and queues only the sub-issues", () => {
    const root = tempDir();
    draftFolder(root, "draft-11112222", PARENT);
    const { store, project } = storeFor(root);
    const { github, run, created, links } = fakeGithub();

    const published = publishDraft({ root, store, project, github, run, ref: "draft-11112222" });

    expect(created.map((c) => [c.number, c.title])).toEqual([
      [20, "Exports"],
      [21, "CSV"],
      [22, "Excel"],
    ]);
    expect(created[2]!.body).toContain("**UI change:** yes · **Risk:** low · **Depends on:** #21\n");
    expect(links).toEqual([
      [20, 21],
      [20, 22],
    ]);
    expect(published.subIssues).toEqual([
      { number: 21, title: "CSV" },
      { number: 22, title: "Excel" },
    ]);
    expect(published.queued).toEqual([21, 22]);
    expect(store.listIssues({ project_id: project.id, queued: true }).map((i) => i.number)).toEqual([21, 22]);
    expect(store.listIssues({ project_id: project.id }).every((i) => i.created_by_factory)).toBe(true);
  });

  it("continues where an interrupted approval stopped, without creating anything twice", () => {
    const root = tempDir();
    draftFolder(root, "draft-11112222", PARENT);
    const { store, project } = storeFor(root);
    const gh = fakeGithub({ failCreateAt: 2 });

    expect(() => publishDraft({ root, store, project, github: gh.github, run: gh.run, ref: "draft-11112222" })).toThrow(/GitHub is down/);
    expect(gh.created.map((c) => c.number)).toEqual([20]);
    expect(listDrafts(root).map((d) => d.created)).toEqual([[20]]);

    gh.state.failCreateAt = undefined;
    publishDraft({ root, store, project, github: gh.github, run: gh.run, ref: "draft-11112222" });
    expect(gh.created.map((c) => [c.number, c.title])).toEqual([
      [20, "Exports"],
      [21, "CSV"],
      [22, "Excel"],
    ]);
    expect(gh.links).toEqual([
      [20, 21],
      [20, 22],
    ]);
  });

  it("validates the draft again before creating anything, as it may have been edited", () => {
    const root = tempDir();
    const dir = draftFolder(root, "draft-11112222", SINGLE);
    writeFileSync(join(dir, "draft.md"), SINGLE.replace("RISK: LOW", "RISK: SOME"));
    const { store, project } = storeFor(root);
    const { github, run, created } = fakeGithub();

    expect(() => publishDraft({ root, store, project, github, run, ref: "draft-11112222" })).toThrow(VerdictParseError);
    expect(() => publishDraft({ root, store, project, github, run, ref: "draft-11112222" })).toThrow(/RISK must be LOW, MEDIUM or HIGH/);
    expect(created).toEqual([]);
  });
});
