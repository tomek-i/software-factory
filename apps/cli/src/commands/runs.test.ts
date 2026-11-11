import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, Store, type GithubPort } from "@factory/core";
import { fakeClaude, git, repoWithRemote, type FakeStep } from "../../../../packages/core/test/helpers.js";
import { CliError } from "../context.js";
import { runApprove, runCancel, runLogs, runReject, runRun, runStatus } from "./runs.js";

const TRIAGE = "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- fine\n";
const BUILD: FakeStep = {
  files: { "feature.txt": "fixed\n" },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", "feat: add feature"],
    ["git", "push", "-q", "-u", "origin", "HEAD"],
  ],
  output: "STATUS: READY\nCOMMIT: {{HEAD}}\n\n## Summary\n- done\n",
};

function setup(steps: FakeStep[], gates = "triage: auto") {
  const config = `version: 1\nchecks:\n  - name: ok\n    run: node -e "process.exit(0)"\ntrust:\n  authors: [alice]\ngates:\n  ${gates}\n`;
  const { root: dir } = repoWithRemote({ "README.md": "# demo\n", ".gitignore": ".factory/runs/\n.factory/factory.db*\n.worktrees/\n", ".factory/config.yaml": config });
  const root = findRepoRoot(dir)!;
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.upsertIssue(project.id, {
    number: 12,
    title: "Add the feature",
    body: "Add feature.txt",
    state: "open",
    author: "alice",
    labels: [],
    url: "https://github.com/o/r/issues/12",
    gh_updated_at: "2026-01-01T00:00:00Z",
  });
  store.close();

  const fake = fakeClaude(steps);
  const github: GithubPort = { commentOnIssue: () => undefined, findPullRequest: () => 7 };
  const printed: string[] = [];
  const queue = () => {
    const s = new Store(join(root, ".factory", "factory.db"));
    s.setQueued(project.id, 12, true);
    s.close();
  };
  const run = () => runRun(dir, "12", {}, { env: fake.env, github, print: (l) => printed.push(l) });
  return { dir, root, run, queue, printed, fake };
}

describe("factory run", () => {
  it("refuses issues that are not queued, with a hint", async () => {
    const { run } = setup([]);
    await expect(run()).rejects.toThrow(/not queued.*factory queue 12/);
  });

  it("drives a queued issue to the review gate and says what to do next", async () => {
    const { run, queue, printed, dir } = setup([{ output: TRIAGE }, BUILD]);
    queue();

    const message = await run();

    expect(message).toMatch(/waiting at the review gate/);
    expect(message).toContain("factory approve");
    expect(printed).toEqual(expect.arrayContaining(["-> triage: issue loaded", "-> build: triage approved"]));
    expect(printed.some((l) => l.startsWith("[gate] ok: passed"))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);

    const status = runStatus(dir);
    expect(status.split("\n")[0]).toMatch(/^RUN\s+ISSUE\s+STATE\s+ROUND\s+COST\s+WAITING$/);
    expect(status).toMatch(/run-12-\w+\s+#12\s+needs_human\s+b1 r1\s+\$0\.08\s+review/);

    const logs = await runLogs(dir, "#12", {});
    expect(logs).toContain("intake -> triage  issue loaded");
    expect(logs).toMatch(/agent agent-\w+ builder ok \$0\.04/);
    expect(await runLogs(dir, "#12", { follow: true, intervalMs: 10 }, { print: () => undefined })).toMatch(/is needs_human/);
  });
});

describe("approve / reject / cancel", () => {
  it("only acts on runs waiting at a gate", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();

    expect(() => runReject(dir, "#12", { message: " " })).toThrow(/Say why/);
    const approved = runApprove(dir, "#12", { message: "go" });
    expect(approved).toContain("Approved the triage gate");
    expect(approved).toContain("factory run 12");
    expect(runStatus(dir)).toMatch(/\bbuild\b/);
    expect(() => runApprove(dir, "#12", {})).toThrow(/not waiting at a gate \(it is build\)/);
    expect(() => runReject(dir, "#12", { message: "no" })).toThrow(CliError);
  });

  it("rejects a waiting run with a reason", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    expect(runReject(dir, "#12", { message: "not now" })).toContain("Rejected");
    expect(runStatus(dir, { all: true })).toMatch(/rejected/);
  });

  it("cancels a run and keeps its worktree", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD]);
    queue();
    await run();
    const worktrees = join(findRepoRoot(dir)!, ".worktrees");

    const message = runCancel(dir, "run-12", {});

    expect(message).toMatch(/^Cancelled run-12-\w+\./);
    expect(message).toContain("The worktree is kept");
    expect(existsSync(worktrees)).toBe(true);
    expect(git(dir, "worktree", "list")).toContain(".worktrees");
    expect(() => runCancel(dir, "#12", {})).toThrow(/already cancelled/);
    expect(runStatus(dir)).toContain("No active runs");
  });

  it("explains unknown run references", () => {
    const { dir } = setup([]);
    expect(() => runApprove(dir, "run-nope", {})).toThrow(/No run "run-nope"/);
    expect(() => runApprove(dir, "#99", {})).toThrow(/No run for issue #99/);
  });
});
