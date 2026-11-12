import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findRepoRoot, runCommand, Store, type CommandRunner, type IssueWriterPort } from "@factory/core";
import { fakeClaude, GIT_TEST_TIMEOUT, repoWithRemote, type FakeStep } from "../../../../packages/core/test/helpers.js";
import { runNew } from "./new.js";

// Each test drives a real git repo and a fake claude process; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.\n";
const block = (title: string, sub = false, extra = "") =>
  `${sub ? "=== SUB-ISSUE ===" : "=== ISSUE ==="}\nTITLE: ${title}\nUI: NO\nRISK: LOW\n${extra}\n${SECTIONS}`;
const draft = (body: string, decision = "PROCEED", reasons = "") => `DECISION: ${decision}\n\n## Summary\n- drafted\n${reasons}\n${body}`;
const SINGLE = draft(block("Add CSV export"));

/** A registered repo whose default branch sets `gates.issue_writer`, and a fake GitHub that numbers issues from 20. */
function setup(steps: FakeStep[], gate?: string) {
  const config = `version: 1\ntrust:\n  authors: [alice]\n${gate ? `gates:\n  issue_writer: ${gate}\n` : ""}`;
  const { root: dir } = repoWithRemote({ "README.md": "# demo\n", ".gitignore": ".factory/runs/\n.factory/factory.db*\n", ".factory/config.yaml": config });
  const root = findRepoRoot(dir)!;
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.close();

  const created: { number: number; title: string; body: string }[] = [];
  const links: [number, number][] = [];
  const github: IssueWriterPort = {
    createIssue: ({ title, body }) => {
      created.push({ number: 20 + created.length, title, body });
      return created.at(-1)!.number;
    },
    addSubIssue: (parent, child) => links.push([parent, child]),
  };
  // `gh issue view` answers for the issues the fake GitHub created; git runs for real.
  const run: CommandRunner = (cmd, args, options) => {
    if (cmd !== "gh") return runCommand(cmd, args, options);
    const issue = created.find((c) => c.number === Number(args[2]));
    if (args[1] !== "view" || !issue) return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    const json = { ...issue, state: "OPEN", author: { login: "factory-operator" }, labels: [], url: `https://github.com/o/r/issues/${issue.number}`, updatedAt: "2026-11-01T00:00:00Z" };
    return { code: 0, stdout: JSON.stringify(json), stderr: "" };
  };

  const fake = fakeClaude(steps);
  const printed: string[] = [];
  const deps = { run, env: fake.env, github, print: (line: string) => printed.push(line) };
  const db = () => new Store(join(root, ".factory", "factory.db"));
  const issues = () => {
    const s = db();
    try {
      return s.listIssues({ project_id: project.id });
    } finally {
      s.close();
    }
  };
  const draftId = (output: string) => /Draft (draft-[0-9a-f]{8})/.exec(output)![1]!;
  return { dir, root, deps, fake, created, links, printed, issues, draftId };
}

describe("factory new", () => {
  it("shows the draft and waits for approval by default, then creates, syncs and queues it", async () => {
    const { dir, root, deps, fake, created, printed, issues, draftId } = setup([{ role: "issue_writer", output: SINGLE }]);

    const output = await runNew(dir, ["Export", "orders as CSV"], {}, deps);

    expect(output).toContain("=== ISSUE ===\nTITLE: Add CSV export");
    expect(output).toMatch(/Draft draft-[0-9a-f]{8} is waiting for you: gate is set to human/);
    const id = draftId(output);
    expect(output).toContain(`create it with \`factory new --approve ${id}\`, or drop it with \`factory new --discard ${id}\``);
    expect(fake.calls()[0]!.stdin).toContain("Export orders as CSV");
    expect(created).toEqual([]);
    expect(printed).toContain("Added .factory/drafts/ to .gitignore");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".factory/drafts/");
    expect(await runNew(dir, [], { list: true }, deps)).toBe(`${id}  Add CSV export`);

    printed.length = 0;
    const approved = await runNew(dir, [], { approve: id }, deps);

    // What becomes a trusted issue is shown in full before it is created.
    expect(printed).toEqual([`${SINGLE.trim()}
`]);
    expect(approved).toBe("Created #20 Add CSV export.\nQueued #20.\nRun it with `factory run 20`.");
    expect(issues()).toMatchObject([{ number: 20, author: "factory-operator", created_by_factory: true }]);
    expect(issues()[0]!.queued_at).not.toBeNull();
    expect(await runNew(dir, [], { list: true }, deps)).toMatch(/^No pending drafts/);
  });

  it("re-reads the saved draft on approval, so edits count and broken edits are refused", async () => {
    const { dir, root, deps, created, draftId } = setup([{ output: SINGLE }]);
    const id = draftId(await runNew(dir, ["an idea"], {}, deps));
    const file = join(root, ".factory", "drafts", id, "draft.md");

    writeFileSync(file, SINGLE.replace("RISK: LOW", "RISK: whatever"));
    await expect(runNew(dir, [], { approve: id }, deps)).rejects.toThrow(/is not valid:\n- issue: RISK must be LOW, MEDIUM or HIGH/);
    expect(created).toEqual([]);

    writeFileSync(file, SINGLE.replace("TITLE: Add CSV export", "TITLE: Export orders as CSV"));
    expect(await runNew(dir, [], { approve: id.slice(0, 10) }, deps)).toContain("Created #20 Export orders as CSV.");
  });

  it("creates a parent with linked sub-issues and queues only the sub-issues when the gate is always", async () => {
    const big = draft(block("Exports") + block("CSV export", true) + block("Excel export", true, "DEPENDS_ON: 1\n"));
    const { dir, deps, created, links, issues, printed } = setup([{ output: big }], "always");

    const output = await runNew(dir, ["exports in every format"], {}, deps);

    expect(output).toBe(
      "Created #20 Exports, with sub-issues:\n  #21 CSV export\n  #22 Excel export\nQueued #21, #22.\nRun them with `factory run 21 22`.",
    );
    expect(created[2]!.body).toContain("**Depends on:** #21");
    expect(printed).toContain(`${big.trim()}
`);
    expect(links).toEqual([
      [20, 21],
      [20, 22],
    ]);
    expect(issues().map((i) => [i.number, i.created_by_factory, i.queued_at !== null])).toEqual([
      [22, true, true],
      [21, true, true],
      [20, true, false],
    ]);
  });

  it("lets the agent decide when the gate is auto", async () => {
    const proceed = setup([{ output: SINGLE }], "auto");
    expect(await runNew(proceed.dir, ["an idea"], {}, proceed.deps)).toContain("Created #20 Add CSV export.");

    const escalate = setup([{ output: draft(block("Add CSV export"), "ESCALATE", "\n## Reasons\n- which columns?\n") }], "auto");
    const output = await runNew(escalate.dir, ["an idea"], {}, escalate.deps);
    expect(output).toMatch(/is waiting for you: which columns\?/);
    expect(escalate.created).toEqual([]);
    expect(await runNew(escalate.dir, [], { list: true }, escalate.deps)).toMatch(/Add CSV export \(escalated\)$/);
  });

  it("reports a draft that is still malformed after the retry and keeps it for a fix or a discard", async () => {
    const { dir, deps, fake } = setup([{ output: "DECISION: PROCEED\n" }, { output: "DECISION: PROCEED\n" }], "always");

    await expect(runNew(dir, ["an idea"], {}, deps)).rejects.toThrow(/rejected twice:\n- the draft needs exactly one "=== ISSUE ===" line/);
    expect(fake.calls()).toHaveLength(2);
    const listed = await runNew(dir, [], { list: true }, deps);
    expect(listed).toMatch(/^draft-[0-9a-f]{8} {2}\(invalid\) an idea/);

    const id = listed.split(" ")[0]!;
    expect(await runNew(dir, [], { discard: id }, deps)).toBe(`Discarded ${id}.`);
    expect(await runNew(dir, [], { list: true }, deps)).toMatch(/^No pending drafts/);
    await expect(runNew(dir, [], { discard: id }, deps)).rejects.toThrow(/No pending draft/);
  });

  it("says when the agent wrote no draft at all, rather than asking to fix a missing file", async () => {
    const { dir, deps } = setup([{}, {}], "always");
    await expect(runNew(dir, ["an idea"], {}, deps)).rejects.toThrow(/was not written\nThe last attempt wrote no draft file\. Drop it with `factory new --discard draft-/);
  });

  it("refuses to create a draft that git tracks, as it may come from someone else's branch", async () => {
    const { dir, root, deps, created, draftId } = setup([{ output: SINGLE }]);
    const id = draftId(await runNew(dir, ["an idea"], {}, deps));
    runCommand("git", ["add", "-f", join(".factory", "drafts", id, "draft.md")], { cwd: root });

    await expect(runNew(dir, [], { approve: id }, deps)).rejects.toThrow(/cannot be created: .*draft\.md is tracked by git/);
    expect(created).toEqual([]);
    expect(await runNew(dir, [], { list: true }, deps)).toBe(`${id}  (refused) an idea  tracked by git`);
  });

  it("needs exactly one of an idea, --approve, --discard or --list", async () => {
    const { dir, deps } = setup([]);
    await expect(runNew(dir, [], {}, deps)).rejects.toThrow(/Give an idea/);
    await expect(runNew(dir, ["  "], {}, deps)).rejects.toThrow(/Give an idea/);
    await expect(runNew(dir, ["idea"], { list: true }, deps)).rejects.toThrow(/Give an idea/);
  });
});
