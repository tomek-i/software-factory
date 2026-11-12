import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findRepoRoot, runDirOf, Store } from "@factory/core";
import { GIT_TEST_TIMEOUT, repoWithRemote } from "../../../../packages/core/test/helpers.js";
import { CliError } from "../context.js";
import { showHint } from "./runs.js";
import { runShow } from "./show.js";

// Each test drives real git repos and child processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const SHA = "a".repeat(40);
const TRIAGE = "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: cli\n\n## Summary\n- adds a show command\n- read-only\n\n## Scope\nall of it\n";
const BUILD = `STATUS: READY\nCOMMIT: ${SHA}\n\n## Summary\n- built it\n`;
const checks = (gate: string, note: string) => `GATE: ${gate}\nCOMMIT: ${SHA}\n\n## Summary\n- ${note}\n`;

/** A registered repo with one run for issue #16 and the given files in its run folder. */
function setup(files: Record<string, string>, fields: { branch?: string; pr_number?: number; waiting_gate?: "triage" | "review" } = {}) {
  const { root: dir } = repoWithRemote({
    "README.md": "# demo\n",
    ".gitignore": ".factory/runs/\n.factory/factory.db*\n",
    ".factory/config.yaml": "version: 1\n",
  });
  const root = findRepoRoot(dir)!;
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.upsertIssue(project.id, {
    number: 16,
    title: "Show a run",
    body: "",
    state: "open",
    author: "alice",
    labels: [],
    url: "https://github.com/o/r/issues/16",
    gh_updated_at: "2026-01-01T00:00:00Z",
  });
  const run = store.createRun({ project_id: project.id, title: "Show a run", issue_number: 16 });
  if (Object.keys(fields).length) store.updateRunFields(run.id, fields);
  store.close();
  const runDir = runDirOf(root, run.id);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(runDir, path)), { recursive: true });
    writeFileSync(join(runDir, path), content);
  }
  return { dir, root, runId: run.id, runDir };
}

describe("factory show <run>", () => {
  it("lists the gate run again after the re-sync and the approver's decision", () => {
    const { dir } = setup({
      "round-2/checks.md": checks("PASS", "round two"),
      "round-2/resync/checks.md": checks("PASS", "after merging main"),
      "approval.md": "DECISION: ESCALATE\n\n## Summary\n- pricing is assumed\n\n## Reasons\n- the issue leaves the price open\n",
    });

    const text = runShow(dir, "16");
    expect(text).toContain("round-2/resync/checks.md (GATE: PASS)\n  - after merging main");
    expect(text).toContain("approval.md (DECISION: ESCALATE)\n  - pricing is assumed");
    expect(runShow(dir, "16", "approval")).toContain("the issue leaves the price open");
  });

  it("lists the latest capture report with its summary, and shows it as `capture`", () => {
    const report = (what: string) => `# Capture\n\n## Summary\n- ${what}\n- no new browser errors\n\n## Pages\n| a |\n`;
    const { dir } = setup({
      "round-1/checks.md": checks("PASS", "round one"),
      "round-1/capture-report.md": report("old capture"),
      "round-2/checks.md": checks("PASS", "round two"),
      "round-2/capture-report.md": report("2 page(s) at 1440 and 390 px"),
      "round-2/capture/after-home-1440.png": "png",
    });

    const text = runShow(dir, "16");
    expect(text).toContain("round-2/capture-report.md\n  - 2 page(s) at 1440 and 390 px\n  - no new browser errors\n");
    expect(text).toContain("  round-2/capture/after-home-1440.png");
    expect(runShow(dir, "16", "capture")).toBe(report("2 page(s) at 1440 and 390 px"));
    expect(() => runShow(setup({ "triage.md": TRIAGE }).dir, "16", "capture")).toThrow(/No round has a capture-report\.md yet/);
  });

  it("prints the run, the verdict summaries with their paths, and the files", () => {
    const { dir, runId } = setup(
      {
        "triage.md": TRIAGE,
        "build.md": BUILD,
        "round-9/checks.md": checks("FAIL", "round nine"),
        "round-10/checks.md": checks("PASS", "round ten"),
        "agent/builder.log": "{}\n",
      },
      { branch: "factory/16-show", pr_number: 7, waiting_gate: "review" },
    );

    const text = runShow(dir, "16");

    expect(text).toContain(`Run ${runId}`);
    expect(text).toMatch(/state:\s+intake/);
    expect(text).toMatch(/waiting:\s+review gate/);
    expect(text).toMatch(/issue:\s+#16 Show a run/);
    expect(text).toMatch(/branch:\s+factory\/16-show/);
    expect(text).toMatch(/PR:\s+#7/);
    expect(text).toContain("triage.md (DECISION: APPROVE)\n  - adds a show command\n  - read-only");
    expect(text).toContain("build.md (STATUS: READY)\n  - built it");
    expect(text).toContain("round-10/checks.md (GATE: PASS)\n  - round ten");
    expect(text).not.toContain("round nine");
    expect(text).toContain(
      ["  agent/builder.log", "  build.md", "  round-10/checks.md", "  round-9/checks.md", "  triage.md"].join("\n"),
    );
  });

  it("shows the latest round's reviews with their blocking findings, and the verifier's judgement", () => {
    const findings = (severity: string) =>
      `## Findings\n\`\`\`json\n[{ "id": "x-1", "severity": "${severity}", "file": "src/a.ts", "line": 3, "claim": "breaks on empty input", "evidence": "a(\\"\\")" }]\n\`\`\`\n`;
    const { dir } = setup({
      "round-1/checks.md": checks("PASS", "one"),
      "round-1/review-code.md": `VERDICT: CHANGES\n\n## Summary\n- one real bug\n\n${findings("major")}`,
      "round-1/review-docs.md": `VERDICT: PASS\n\n## Summary\n- docs fine\n\n${findings("nit")}`,
      "round-1/review-security.md": "VERDICT: MAYBE\n",
      "round-1/verify.md": `VERDICT: CONFIRMED\n\n## Summary\n- the bug is real\n\n${findings("major")}\n## Refuted\n- y-1: not reachable\n`,
    });

    const text = runShow(dir, "16");

    expect(text).toContain("round-1/review-code.md (VERDICT: CHANGES)\n  - one real bug\n  major: breaks on empty input (src/a.ts:3)");
    expect(text).toContain("round-1/review-docs.md (VERDICT: PASS)\n  - docs fine\n\n");
    expect(text).toMatch(/round-1\/review-security\.md \(could not be parsed: .+\)/);
    expect(text).toContain("round-1/verify.md (VERDICT: CONFIRMED)\n  - the bug is real\n  major: breaks on empty input (src/a.ts:3)\n  refuted: 1\n");
  });

  it("resolves the run like the other commands", () => {
    const { dir, runId } = setup({ "triage.md": TRIAGE });
    for (const ref of ["#16", runId, runId.slice(0, runId.length - 3)]) {
      expect(runShow(dir, ref)).toContain(`Run ${runId}`);
    }
    expect(() => runShow(dir, "99")).toThrow(/No run for issue #99/);
  });

  it("leaves out what is not there yet and survives malformed verdicts", () => {
    const { dir } = setup({ "triage.md": "nonsense\n", "build.md": "STATUS: MAYBE\n" });
    const text = runShow(dir, "16");
    expect(text).toMatch(/branch:\s+-/);
    expect(text).toMatch(/PR:\s+-/);
    expect(text).not.toContain("waiting:");
    expect(text).toMatch(/triage\.md \(could not be parsed: .+\)/);
    expect(text).toMatch(/build\.md \(could not be parsed: .+\)/);
    expect(text).toContain("  build.md\n  triage.md");
  });

  it("says there are no files when the run folder does not exist", () => {
    const { dir } = setup({});
    expect(runShow(dir, "16")).toMatch(/No files yet: .* does not exist\./);
  });
});

describe("factory show <run> <file>", () => {
  const files = {
    "triage.md": TRIAGE,
    "build.md": BUILD,
    "round-1/checks.md": checks("FAIL", "first"),
    "round-2/checks.md": checks("PASS", "second"),
  };

  it("prints a verdict file in full by short name or path", () => {
    const { dir } = setup(files);
    expect(runShow(dir, "16", "triage")).toBe(TRIAGE);
    expect(runShow(dir, "16", "triage.md")).toBe(TRIAGE);
    expect(runShow(dir, "16", "build")).toBe(BUILD);
    expect(runShow(dir, "16", "checks")).toBe(files["round-2/checks.md"]);
    expect(runShow(dir, "16", "round-1/checks.md")).toBe(files["round-1/checks.md"]);
    expect(runShow(dir, "16", "round-1\\checks.md")).toBe(files["round-1/checks.md"]);
    expect(runShow(dir, "16", "./round-1/../triage.md")).toBe(TRIAGE);
  });

  it("refuses paths outside the run folder without printing them", () => {
    const { dir, root, runDir } = setup(files);
    writeFileSync(join(root, "secret.txt"), "do not show\n");
    const outside = [
      "../../../secret.txt",
      "..\\..\\..\\secret.txt",
      "round-1/../../x",
      "round-1\\..\\..\\x",
      "..",
      join(root, "secret.txt"),
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "C:secret.txt",
      "\\\\server\\share\\x",
    ];
    for (const path of outside) {
      let error: unknown;
      try {
        runShow(dir, "16", path);
      } catch (err) {
        error = err;
      }
      expect(error, path).toBeInstanceOf(CliError);
      expect((error as Error).message, path).toMatch(/outside the run folder/);
      expect((error as Error).message).not.toContain("do not show");
    }
    // Sanity: the outside file really is there, so the refusals above are not "missing file" errors.
    expect(readFileSync(join(runDir, "..", "..", "..", "secret.txt"), "utf8")).toBe("do not show\n");
  });

  it("lists the existing files when the file is missing or a folder", () => {
    const { dir } = setup(files);
    const listing = /Files there:\n {2}build\.md\n {2}round-1\/checks\.md\n {2}round-2\/checks\.md\n {2}triage\.md$/;
    expect(() => runShow(dir, "16", "verify.md")).toThrow(/No file "verify\.md"/);
    expect(() => runShow(dir, "16", "verify.md")).toThrow(listing);
    expect(() => runShow(dir, "16", "round-1")).toThrow(listing);
    expect(() => runShow(dir, "16", "toString")).toThrow(/No file "toString"/);
  });

  it("explains when no round has checks yet", () => {
    const { dir } = setup({ "triage.md": TRIAGE });
    expect(() => runShow(dir, "16", "checks")).toThrow(/No round has a checks\.md yet[\s\S]*triage\.md/);
  });
});

describe("showHint", () => {
  it("names the verdict file each gate is about", () => {
    expect(showHint({ id: "run-1-a", waiting_gate: "triage" })).toBe("See it with: `factory show run-1-a triage`.");
    // Several lenses write reviews, so the review gate points at the overview, which lists them.
    expect(showHint({ id: "run-1-a", waiting_gate: "review" })).toBe("See it with: `factory show run-1-a`.");
    expect(showHint({ id: "run-1-a", waiting_gate: "plan" })).toBe("See it with: `factory show run-1-a`.");
  });
});
