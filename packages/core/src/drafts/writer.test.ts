import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema, VerdictParseError } from "@factory/shared";
import { fakeClaude, git, tempDir, type FakeStep } from "../../test/helpers.js";
import { createAgentRunner } from "../agents/runner.js";
import type { IssueWriterPort } from "../github/port.js";
import { Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { discardDraft, DraftError, DRAFTS_DIR, findDraft, listDrafts, publishDraft, writeDraft, type DraftContext } from "./writer.js";

const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.\n";
const block = (title: string, header = "UI: NO\nRISK: LOW", sub = false) =>
  `${sub ? "=== SUB-ISSUE ===" : "=== ISSUE ==="}\nTITLE: ${title}\n${header}\n\n${SECTIONS}`;
const SINGLE = `DECISION: PROCEED\n\n## Summary\n- one issue\n\n${block("Add CSV export")}`;
const PARENT = `DECISION: PROCEED\n\n## Summary\n- split\n\n${block("Exports")}${block("CSV", undefined, true)}${block("Excel", "UI: YES\nRISK: LOW\nDEPENDS_ON: 1", true)}`;

/** A git repository, so drafts can be checked against what git tracks. */
function repo(): string {
  const root = tempDir();
  git(root, "init", "-q");
  return root;
}

/** A draft folder as the issue writer leaves it. */
function draftFolder(root: string, id: string, text: string | undefined, idea = "an idea"): string {
  const dir = join(root, DRAFTS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "idea.md"), `${idea}\n`);
  if (text !== undefined) writeFileSync(join(dir, "draft.md"), text);
  return dir;
}

/**
 * GitHub as far as publishing needs it: numbers from 20 up, `gh issue view` answers for what it
 * created; git runs for real. `state` is mutable, so a test can break GitHub and let it recover.
 */
function fakeGithub(state: { failCreateAt?: number; failLink?: boolean; failView?: boolean } = {}) {
  const created: { number: number; title: string; body: string }[] = [];
  const links: [number, number][] = [];
  const github: IssueWriterPort = {
    createIssue: ({ title, body }) => {
      if (created.length + 1 === state.failCreateAt) throw new Error("GitHub is down");
      created.push({ number: 20 + created.length, title, body });
      return created.at(-1)!.number;
    },
    addSubIssue: (parent, child) => {
      if (state.failLink) throw new Error("linking failed");
      links.push([parent, child]);
    },
  };
  const run: CommandRunner = (cmd, args, options) => {
    if (cmd !== "gh") return runCommand(cmd, args, options);
    const issue = created.find((c) => c.number === Number(args[2]));
    if (state.failView || !issue) return { code: 1, stdout: "", stderr: "view failed" };
    const json = { ...issue, state: "OPEN", author: { login: "someone" }, labels: [], url: `https://github.com/o/r/issues/${issue.number}`, updatedAt: "2026-11-01T00:00:00Z" };
    return { code: 0, stdout: JSON.stringify(json), stderr: "" };
  };
  return { github, run, created, links, state };
}

function contextFor(root: string, run?: CommandRunner): DraftContext {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  return { root, store, project, run };
}

describe("writeDraft", () => {
  const config = factoryConfigSchema.parse({ version: 1, models: { roles: { issue_writer: "sonnet" } } });
  const write = (steps: FakeStep[], root = repo()) => {
    const fake = fakeClaude(steps);
    const read = (path: string) => (path === ".factory/lessons.md" ? "Keep issues small.\n" : undefined);
    return { fake, root, result: writeDraft({ root, config, read, runAgent: createAgentRunner({ env: fake.env }), idea: "  Export orders as CSV  " }) };
  };

  it("runs the issue writer on the idea in a new draft folder, with no shell and only its draft to write", async () => {
    const root = repo();
    draftFolder(root, "draft-0ther000", SINGLE);
    const { fake, result } = write([{ role: "issue_writer", output: SINGLE }], root);
    const draft = await result;

    expect(draft.turn.status).toBe("ok");
    expect(draft.id).toMatch(/^draft-[0-9a-f]{8}$/);
    expect(draft.dir).toBe(join(root, DRAFTS_DIR, draft.id));
    expect(readFileSync(join(draft.dir, "idea.md"), "utf8")).toBe("Export orders as CSV\n");
    const settings = JSON.parse(readFileSync(join(draft.dir, "agent", "issue_writer.settings.json"), "utf8"));
    expect(settings.permissions.allow).toHaveLength(4);
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Bash", "Read(.factory/runs/**)", "Read(.worktrees/**)", "Read(.factory/drafts/draft-0ther000/**)"]),
    );
    expect(settings.permissions.deny).not.toContain(`Read(.factory/drafts/${draft.id}/**)`);

    const [call] = fake.calls();
    expect(call!.role).toBe("issue_writer");
    expect(call!.cwd).toBe(root);
    expect(call!.argv).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(call!.stdin).toContain("## Idea\nFrom the factory's operator, a trusted author.");
    expect(call!.stdin).toContain("Export orders as CSV");
    expect(call!.stdin).toContain("Keep issues small.");
    expect(findDraft(contextFor(root), draft.id).draft!.issue.title).toBe("Add CSV export");
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
    const root = repo();
    draftFolder(root, "draft-aaaa1111", SINGLE, "first");
    draftFolder(root, "draft-aaaa2222", "DECISION: PROCEED\n", "second");
    draftFolder(root, "draft-bbbb3333", undefined, "third");
    const ctx = contextFor(root);

    const drafts = listDrafts(ctx);
    expect(drafts.map((d) => [d.id, d.idea, d.problems.length > 0])).toEqual(
      expect.arrayContaining([
        ["draft-aaaa1111", "first", false],
        ["draft-aaaa2222", "second", true],
        ["draft-bbbb3333", "third", true],
      ]),
    );
    expect(drafts.find((d) => d.id === "draft-bbbb3333")!.problems).toEqual(["the issue writer did not write a draft"]);

    expect(findDraft(ctx, "draft-b").id).toBe("draft-bbbb3333");
    expect(() => findDraft(ctx, "draft-aaaa")).toThrow(/matches several drafts/);
    expect(() => findDraft(ctx, "../draft-aaaa1111")).toThrow(/No pending draft/);

    const dropped = discardDraft(ctx, "draft-aaaa2222");
    expect(existsSync(dropped.dir)).toBe(false);
    expect(listDrafts(ctx)).toHaveLength(2);
    expect(listDrafts(contextFor(repo()))).toEqual([]);
  });

  it("marks only the draft it cannot read as invalid, and keeps working with the others", () => {
    const root = repo();
    draftFolder(root, "draft-aaaa1111", SINGLE);
    // A folder where the draft file should be: reading it fails with EISDIR.
    mkdirSync(join(draftFolder(root, "draft-bbbb2222", undefined), "draft.md"));
    const ctx = contextFor(root);

    expect(findDraft(ctx, "draft-bbbb2222").problems[0]).toMatch(/EISDIR/);
    expect(findDraft(ctx, "draft-aaaa1111").draft!.issue.title).toBe("Add CSV export");
    const { github, run } = fakeGithub();
    expect(publishDraft({ ...ctx, run, github, ref: "draft-aaaa1111" }).issue.number).toBe(20);
    discardDraft(ctx, "draft-bbbb2222");
    expect(listDrafts(ctx)).toEqual([]);
  });

  it("refuses a draft whose files git tracks: it may come from someone else's branch", () => {
    const root = repo();
    const dir = draftFolder(root, "draft-aaaa1111", SINGLE);
    git(root, "add", "-f", join(dir, "draft.md"));
    const { github, run, created } = fakeGithub();
    const ctx = contextFor(root, run);

    expect(findDraft(ctx, "draft-aaaa1111").refusal).toMatch(/^\.factory\/drafts\/draft-aaaa1111\/draft\.md is tracked by git/);
    expect(() => publishDraft({ ...ctx, github, ref: "draft-aaaa1111" })).toThrow(DraftError);
    expect(() => publishDraft({ ...ctx, github, ref: "draft-aaaa1111" })).toThrow(/cannot be created: .* tracked by git/);
    expect(created).toEqual([]);
  });

  it("ignores progress files in the draft folder: what was created is only known to the store", () => {
    const root = repo();
    const dir = draftFolder(root, "draft-aaaa1111", SINGLE);
    // Where an earlier version kept its progress; a branch could plant one naming someone else's issue.
    writeFileSync(join(dir, "created.json"), JSON.stringify({ numbers: [42], linked: [], done: false }));
    const { github, run } = fakeGithub();
    const ctx = contextFor(root, run);

    expect(findDraft(ctx, "draft-aaaa1111").created).toEqual([]);
    expect(publishDraft({ ...ctx, github, ref: "draft-aaaa1111" }).issue.number).toBe(20);
    expect(ctx.store.getIssue(ctx.project.id, 42)).toBeUndefined();
  });
});

describe("publishDraft", () => {
  it("creates a single issue, syncs it as created by the factory and queues it", () => {
    const root = repo();
    draftFolder(root, "draft-11112222", SINGLE);
    const { github, run, created, links } = fakeGithub();
    const ctx = contextFor(root, run);
    const { store, project } = ctx;

    const published = publishDraft({ ...ctx, github, ref: "draft-1111" });

    expect(published).toEqual({ id: "draft-11112222", issue: { number: 20, title: "Add CSV export" }, subIssues: [], queued: [20] });
    expect(created[0]!.body).toBe(`${SECTIONS.trim()}\n\n---\n\n**UI change:** no · **Risk:** low\n`);
    expect(links).toEqual([]);
    expect(store.getIssue(project.id, 20)).toMatchObject({ author: "someone", created_by_factory: true });
    expect(store.getIssue(project.id, 20)!.queued_at).not.toBeNull();
    // Created drafts are no longer pending.
    expect(listDrafts(ctx)).toEqual([]);
    expect(() => publishDraft({ ...ctx, github, ref: "draft-11112222" })).toThrow(/No pending draft/);
  });

  it("creates a parent and linked sub-issues in order, and queues only the sub-issues", () => {
    const root = repo();
    draftFolder(root, "draft-11112222", PARENT);
    const { github, run, created, links } = fakeGithub();
    const ctx = contextFor(root, run);

    const published = publishDraft({ ...ctx, github, ref: "draft-11112222" });

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
    expect(ctx.store.listIssues({ project_id: ctx.project.id, queued: true }).map((i) => i.number)).toEqual([21, 22]);
    expect(ctx.store.listIssues({ project_id: ctx.project.id }).every((i) => i.created_by_factory)).toBe(true);
  });

  /** Publish PARENT with GitHub broken one way, then again after it recovered. */
  function interrupted(state: Parameters<typeof fakeGithub>[0], before?: (ctx: DraftContext) => void) {
    const root = repo();
    draftFolder(root, "draft-11112222", PARENT);
    const gh = fakeGithub(state);
    const ctx = contextFor(root, gh.run);
    before?.(ctx);
    const failure = (() => {
      try {
        publishDraft({ ...ctx, github: gh.github, ref: "draft-11112222" });
      } catch (err) {
        return (err as Error).message;
      }
    })();
    const createdBefore = gh.created.map((c) => c.number);
    for (const key of Object.keys(gh.state)) delete gh.state[key as keyof typeof gh.state];
    publishDraft({ ...ctx, github: gh.github, ref: "draft-11112222" });
    return { ...gh, ctx, failure, createdBefore };
  }

  const expectComplete = (gh: ReturnType<typeof interrupted>) => {
    expect(gh.created.map((c) => [c.number, c.title])).toEqual([
      [20, "Exports"],
      [21, "CSV"],
      [22, "Excel"],
    ]);
    expect(gh.links).toEqual([
      [20, 21],
      [20, 22],
    ]);
    expect(gh.ctx.store.listIssues({ project_id: gh.ctx.project.id, queued: true }).map((i) => i.number)).toEqual([21, 22]);
    expect(gh.ctx.store.listIssues({ project_id: gh.ctx.project.id }).every((i) => i.created_by_factory)).toBe(true);
    expect(listDrafts(gh.ctx)).toEqual([]);
  };

  it("continues after a failed create without creating anything twice", () => {
    const gh = interrupted({ failCreateAt: 2 });
    expect(gh.failure).toBe("GitHub is down");
    expect(gh.createdBefore).toEqual([20]);
    expectComplete(gh);
  });

  it("continues after a failed sub-issue link, linking only what is left", () => {
    const gh = interrupted({ failLink: true });
    expect(gh.failure).toBe("linking failed");
    expect(gh.createdBefore).toEqual([20, 21, 22]);
    expectComplete(gh);
  });

  it("continues after the sync failed, and after marking an issue failed", () => {
    const view = interrupted({ failView: true });
    expect(view.failure).toMatch(/gh issue view failed/);
    expectComplete(view);

    const mark = interrupted({}, (ctx) => {
      vi.spyOn(ctx.store, "markCreatedByFactory").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    });
    expect(mark.failure).toBe("disk full");
    expectComplete(mark);
  });

  it("refuses an entry edited after its issue was created, but takes edits to the ones not created yet", () => {
    const root = repo();
    const dir = draftFolder(root, "draft-11112222", PARENT);
    const gh = fakeGithub({ failCreateAt: 3 });
    const ctx = contextFor(root, gh.run);
    expect(() => publishDraft({ ...ctx, github: gh.github, ref: "draft-11112222" })).toThrow(/GitHub is down/);
    delete gh.state.failCreateAt;

    // Swapping the sub-issues would put #21 (created as "CSV") in the place of "Excel".
    const swapped = `DECISION: PROCEED\n\n${block("Exports")}${block("Excel", undefined, true)}${block("CSV", undefined, true)}`;
    writeFileSync(join(dir, "draft.md"), swapped);
    expect(() => publishDraft({ ...ctx, github: gh.github, ref: "draft-11112222" })).toThrow(
      /sub-issue 1 of draft draft-11112222 was already created as #21 and has changed since/,
    );
    writeFileSync(join(dir, "draft.md"), `DECISION: PROCEED\n\n${block("Exports")}`);
    expect(() => publishDraft({ ...ctx, github: gh.github, ref: "draft-11112222" })).toThrow(/already created as #21 and has changed since \(or is gone\)/);
    expect(gh.created).toHaveLength(2);

    writeFileSync(join(dir, "draft.md"), PARENT.replace("TITLE: Excel", "TITLE: Excel export"));
    publishDraft({ ...ctx, github: gh.github, ref: "draft-11112222" });
    expect(gh.created.map((c) => c.title)).toEqual(["Exports", "CSV", "Excel export"]);
  });

  it("validates the draft again before creating anything, as it may have been edited", () => {
    const root = repo();
    const dir = draftFolder(root, "draft-11112222", SINGLE);
    writeFileSync(join(dir, "draft.md"), SINGLE.replace("RISK: LOW", "RISK: SOME"));
    const { github, run, created } = fakeGithub();
    const ctx = contextFor(root, run);

    expect(() => publishDraft({ ...ctx, github, ref: "draft-11112222" })).toThrow(VerdictParseError);
    expect(() => publishDraft({ ...ctx, github, ref: "draft-11112222" })).toThrow(/RISK must be LOW, MEDIUM or HIGH/);
    expect(created).toEqual([]);
  });
});
