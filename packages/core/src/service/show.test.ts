import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { runDirOf } from "../pipeline/driver.js";
import { Store } from "../store/store.js";
import { ServiceError } from "./errors.js";
import { latestChecks, latestRoundFile, listRunFiles, resolveInRunDir, runFile, runOverview } from "./show.js";

const SHA = "a".repeat(40);
const TRIAGE = "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: cli\n\n## Summary\n- adds a show command\n";
const checks = (gate: string, note: string) => `GATE: ${gate}\nCOMMIT: ${SHA}\n\n## Summary\n- ${note}\n`;
const findings = (severity: string) =>
  `## Findings\n\`\`\`json\n[{ "id": "x-1", "severity": "${severity}", "file": "src/a.ts", "line": 3, "claim": "breaks on empty input", "evidence": "e" }]\n\`\`\`\n`;

/** A project in a plain folder (show reads only the run folder) with one run for #16 and these files. */
function setup(files: Record<string, string> = {}) {
  const root = tempDir();
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.upsertIssue(project.id, { number: 16, title: "Show a run", body: "", state: "open", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
  const run = store.createRun({ project_id: project.id, title: "Run title", issue_number: 16 });
  const runDir = runDirOf(root, run.id);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(runDir, path)), { recursive: true });
    writeFileSync(join(runDir, path), content);
  }
  return { store, project, run, runDir };
}

describe("runOverview", () => {
  it("returns the run, its issue title, and a section per verdict file in pipeline order", () => {
    const { store, project, run, runDir } = setup({
      "triage.md": TRIAGE,
      "round-1/checks.md": checks("FAIL", "one"),
      "round-2/checks.md": checks("PASS", "two"),
      "round-2/review-code.md": `VERDICT: CHANGES\n\n## Summary\n- one real bug\n\n${findings("major")}`,
      "round-2/review-docs.md": "VERDICT: MAYBE\n",
      "round-2/verify.md": `VERDICT: CONFIRMED\n\n## Summary\n- the bug is real\n\n${findings("major")}\n## Refuted\n- y-1: not reachable\n`,
      "round-2/capture-report.md": "# Capture\n\n## Summary\n- shot the home page\n\n## Pages\n",
      "build.md": "not a verdict\n",
    });

    const overview = runOverview(store, project, "#16");

    expect(overview).toMatchObject({ run: { id: run.id }, issueTitle: "Show a run", runDir, hasRunDir: true });
    expect(overview.files).toEqual([
      "build.md",
      "round-1/checks.md",
      "round-2/capture-report.md",
      "round-2/checks.md",
      "round-2/review-code.md",
      "round-2/review-docs.md",
      "round-2/verify.md",
      "triage.md",
    ]);
    const blocking = [{ id: "x-1", severity: "major", file: "src/a.ts", line: 3, claim: "breaks on empty input", evidence: "e" }];
    expect(overview.sections).toEqual([
      { kind: "verdict", path: "triage.md", key: "DECISION", value: "APPROVE", summary: ["adds a show command"], blocking: [], refuted: 0 },
      { kind: "unparsed", path: "build.md", problem: expect.any(String) },
      { kind: "verdict", path: "round-2/checks.md", key: "GATE", value: "PASS", summary: ["two"], blocking: [], refuted: 0 },
      { kind: "verdict", path: "round-2/review-code.md", key: "VERDICT", value: "CHANGES", summary: ["one real bug"], blocking, refuted: 0 },
      { kind: "unparsed", path: "round-2/review-docs.md", problem: expect.any(String) },
      { kind: "verdict", path: "round-2/verify.md", key: "VERDICT", value: "CONFIRMED", summary: ["the bug is real"], blocking, refuted: 1 },
      { kind: "capture", path: "round-2/capture-report.md", summary: ["shot the home page"] },
    ]);
  });

  it("shows the acceptance lens per criterion, in place of its review file", () => {
    const criteria = [
      { id: "AC-1", source: "issue", text: "shows a run", status: "MET", evidence: "show.test.ts" },
      { id: "AC-2", source: "spec", text: "looks right on a phone", status: "CANNOT_CHECK", evidence: "needs a browser" },
    ];
    const { store, project } = setup({
      "round-1/checks.md": checks("PASS", "one"),
      "round-1/acceptance.json": JSON.stringify({ criteria }),
      "round-1/review-acceptance.md": "VERDICT: PASS\n\n## Summary\n- Acceptance criteria: 1/1 met\n\n## Findings\n```json\n[]\n```\n",
    });

    expect(runOverview(store, project, "#16").sections).toEqual([
      { kind: "verdict", path: "round-1/checks.md", key: "GATE", value: "PASS", summary: ["one"], blocking: [], refuted: 0 },
      { kind: "acceptance", path: "round-1/acceptance.json", count: "1/1 met, 1 for you to check", criteria },
    ]);
  });

  it("has no files or sections before the run folder exists", () => {
    const { store, project, run } = setup();
    expect(runOverview(store, project, run.id)).toMatchObject({ hasRunDir: false, files: [], sections: [] });
  });
});

describe("runFile and resolveInRunDir", () => {
  it("returns a file as it is on disk, by short name or path", () => {
    const { store, project, run } = setup({ "triage.md": TRIAGE, "round-2/checks.md": checks("PASS", "two"), "round-10/checks.md": checks("PASS", "ten") });
    expect(runFile(store, project, run.id, "triage")).toEqual({ run: expect.objectContaining({ id: run.id }), path: "triage.md", text: TRIAGE });
    expect(runFile(store, project, run.id, "checks").path).toBe("round-10/checks.md");
    expect(runFile(store, project, run.id, "round-2\\checks.md").text).toBe(checks("PASS", "two"));
  });

  it("refuses paths outside the run folder and names the files when one is missing", () => {
    const { store, project, run, runDir } = setup({ "triage.md": TRIAGE });
    for (const outside of ["../x", "..\\x", "/etc/passwd", "C:\\x", "a/../../x"]) {
      expect(() => resolveInRunDir(runDir, outside, ["triage.md"])).toThrow(ServiceError);
    }
    expect(() => resolveInRunDir(runDir, "critic", ["triage.md"])).toThrow(new ServiceError("No spec round has a critic.md yet. Files in the run folder:\n  triage.md"));
    expect(() => runFile(store, project, run.id, "build")).toThrow(new ServiceError(`No file "build.md" in the run folder of ${run.id}. Files there:\n  triage.md`));
  });

  it("picks the highest round numerically", () => {
    const files = ["round-9/checks.md", "round-10/checks.md", "spec-2/critic.md", "spec-1/critic.md", "round-11/sub/checks.md"];
    expect(latestChecks(files)).toBe("round-10/checks.md");
    expect(latestRoundFile(files, "spec", "critic.md")).toBe("spec-2/critic.md");
    expect(listRunFiles(join(tempDir(), "missing"))).toEqual([]);
  });
});
