import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUT, tempDir } from "../../../../packages/core/test/helpers.js";
import { setup } from "../../test/runs-setup.js";
import { CliError } from "../context.js";
import { runExport, runImport } from "./snapshot.js";

// Each test copies real git repos; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const NOW = new Date("2026-11-16T10:00:00.000Z");

/** Machine A: #12 queued, #13 opened by the factory, a finished run with a decided lesson, and an active run. */
function laptop() {
  const ctx = setup([]);
  const store = ctx.db();
  store.setQueued(ctx.projectId, 12, true);
  store.markCreatedByFactory(ctx.projectId, 13);
  const done = store.createRun({ project_id: ctx.projectId, title: "Add the feature", issue_number: 12 });
  store.writeState(done.id, "rejected");
  const [lesson] = store.addLessons(done.id, [{ observation: "o", evidence: "e", rule: "Run lint first." }]);
  store.decideLessons([lesson!.id], "approved", { pull_request: 8 });
  const active = store.createRun({ project_id: ctx.projectId, title: "Add another feature", issue_number: 13 });
  store.writeState(active.id, "build");
  store.close();
  return { ...ctx, doneId: done.id, activeId: active.id };
}

function exportTo(dir: string, file?: string) {
  const warnings: string[] = [];
  const out = runExport(dir, file, { warn: (l) => warnings.push(l), now: NOW, host: "laptop" });
  return { out, warnings };
}

describe("factory export", () => {
  it("prints the snapshot to stdout and the active runs it left out to stderr", () => {
    const a = laptop();
    const { out, warnings } = exportTo(a.dir);
    const snapshot = JSON.parse(out) as { header: unknown; runs: { id: string }[] };
    expect(snapshot.header).toMatchObject({ format_version: 1, exported_at: NOW.toISOString(), host: "laptop", github_repo: "o/r" });
    expect(snapshot.runs.map((r) => r.id)).toEqual([a.doneId]);
    expect(out).not.toContain(a.root.replace(/\\/g, "\\\\"));
    expect(warnings).toEqual([`1 active run not exported: finish or cancel them on this machine first (${a.activeId}).`]);
  });

  it("writes to a file outside the repo without a warning", () => {
    const a = laptop();
    const file = join(tempDir("factory-snapshot-"), "laptop.json");
    const { out, warnings } = exportTo(a.dir, file);
    expect(out).toBe(`Exported 1 finished run, 2 issues and 1 lesson to ${file}.\nOn the other machine: \`factory import <file>\`, then \`factory sync\`.`);
    expect(warnings.filter((w) => w.startsWith("warning:"))).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveProperty("header.github_repo", "o/r");
  });

  it("warns when the file is inside the repository's working tree", () => {
    const a = laptop();
    const { warnings } = exportTo(a.dir, "snapshot.json");
    expect(warnings).toContainEqual(expect.stringMatching(/^warning: snapshot\.json is inside the repository\. .*never commit it\. Keep it outside the repo, e\.g\. /));
    expect(existsSync(join(a.dir, "snapshot.json"))).toBe(true);
    // Gitignored folders are still the working tree.
    const nested = exportTo(a.dir, join(a.root, ".factory", "snapshot.json"));
    expect(nested.warnings).toContainEqual(expect.stringMatching(/is inside the repository/));
  });
});

describe("factory import", () => {
  /** A's snapshot in a file outside both repos, and machine B: another clone of o/r with its own store. */
  function carried() {
    const a = laptop();
    const file = join(tempDir("factory-snapshot-"), "laptop.json");
    exportTo(a.dir, file);
    const b = setup([]);
    return { a, b, file };
  }

  it("previews with --dry-run, imports, and finds nothing to do the second time", () => {
    const { a, b, file } = carried();

    const dry = runImport(b.dir, file, { dryRun: true });
    expect(dry).toBe(
      [
        `Would add or change from the snapshot from laptop, exported ${NOW.toISOString()}:`,
        "  runs: 1 added",
        "  run events: 1 added",
        "  issues: 1 queued (#12), 1 marked as opened by the factory (#13)",
        "  lessons: 1 added",
        "",
        "Nothing was written (--dry-run).",
      ].join("\n"),
    );
    let store = b.db();
    expect(store.getRun(a.doneId)).toBeUndefined();
    expect(store.getIssue(b.projectId, 12)?.queued_at).toBeNull();
    store.close();

    expect(runImport(b.dir, file)).toBe(dry.replace("Would add or change", "Imported").replace("Nothing was written (--dry-run).", "Run `factory sync` to refresh the issues from GitHub."));
    store = b.db();
    expect(store.getRun(a.doneId)).toMatchObject({ state: "rejected", project_id: b.projectId });
    expect(store.getRun(a.activeId)).toBeUndefined();
    expect(store.getIssue(b.projectId, 12)?.queued_at).not.toBeNull();
    expect(store.getIssue(b.projectId, 13)?.created_by_factory).toBe(true);
    expect(store.listLessons({ project_id: b.projectId })).toEqual([expect.objectContaining({ status: "approved", pull_request: 8 })]);
    store.close();

    expect(runImport(b.dir, file)).toBe(
      `Nothing to import: this database already has everything in the snapshot from laptop, exported ${NOW.toISOString()}.\n1 run already here, left as they are.`,
    );
  });

  it("refuses another repository's snapshot and leaves the store alone", () => {
    const { b, file } = carried();
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as { header: { github_repo: string } };
    snapshot.header.github_repo = "someone/else";
    writeFileSync(file, JSON.stringify(snapshot));
    expect(() => runImport(b.dir, file)).toThrow(new CliError("The snapshot is of someone/else, but this repository is o/r. Import it in a clone of someone/else."));
    const store = b.db();
    expect(store.getIssue(b.projectId, 12)?.queued_at).toBeNull();
    expect(store.listRuns({ project_id: b.projectId })).toEqual([]);
    store.close();
  });

  it("refuses a snapshot from a newer factory", () => {
    const { b, file } = carried();
    const snapshot = JSON.parse(readFileSync(file, "utf8")) as { header: { schema_version: number } };
    snapshot.header.schema_version += 1;
    writeFileSync(file, JSON.stringify(snapshot));
    expect(() => runImport(b.dir, file)).toThrow(/^The snapshot was exported by a newer factory \(database schema \d+, this one has \d+\)\. Upgrade the factory on this machine, then import again\.$/);
  });

  it("says when the file is missing or not JSON", () => {
    const { b } = carried();
    const dir = tempDir("factory-snapshot-");
    expect(() => runImport(b.dir, join(dir, "nope.json"))).toThrow(/^Could not read .*nope\.json: /);
    writeFileSync(join(dir, "bad.json"), "{");
    expect(() => runImport(b.dir, join(dir, "bad.json"))).toThrow(new CliError(`${join(dir, "bad.json")} is not a factory snapshot: it is not JSON.`));
  });
});
