import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import { loadConfig } from "../config/load.js";
import { DRAFTS_DIR } from "../drafts/writer.js";
import type { IssueWriterPort } from "../github/port.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { approveDraft, discardPendingDraft, draftIssue, ensureDraftsIgnored, pendingDrafts } from "./drafts.js";
import { ServiceError } from "./errors.js";
import type { ServiceContext } from "./runs.js";

// Each test drives a real git repo and a fake claude process; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.\n";
const SINGLE = `DECISION: PROCEED\n\n## Summary\n- drafted\n\n=== ISSUE ===\nTITLE: Add CSV export\nUI: NO\nRISK: LOW\n\n${SECTIONS}`;

/** A repo whose default branch sets `gates.issue_writer`, and a fake GitHub that numbers issues from 20. */
function context(steps: FakeStep[], gate: string) {
  const s = setup(steps, { config: `version: 1\ntrust:\n  authors: [alice]\ngates:\n  issue_writer: ${gate}\n` });
  const ctx: ServiceContext = { store: s.store, project: s.project, config: loadConfig(s.root) };
  const created: { number: number; title: string; body: string }[] = [];
  const github: IssueWriterPort = {
    createIssue: ({ title, body }) => {
      created.push({ number: 20 + created.length, title, body });
      return created.at(-1)!.number;
    },
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
    expect(published).toEqual({ id: outcome.id, issue: { number: 20, title: "Add CSV export" }, subIssues: [], queued: [20] });
    expect(pendingDrafts(ctx, deps.run)).toEqual([]);
  });

  it("creates the draft straight away when the gate lets it through", async () => {
    const { ctx, created, deps } = context([{ role: "issue_writer", output: SINGLE }], "always");
    const shown: string[] = [];

    const outcome = await draftIssue(ctx, "export the table as CSV", { ...deps, onCreate: (text) => shown.push(text) });

    expect(outcome).toMatchObject({ kind: "created", published: { issue: { number: 20 } } });
    expect(shown).toEqual([SINGLE]);
    expect(created.map((c) => c.title)).toEqual(["Add CSV export"]);
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
