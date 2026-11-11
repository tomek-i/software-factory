/**
 * Shared setup for the `factory run` / approve / resume command tests. They are split over several
 * `runs*.test.ts` files so Vitest runs them in parallel: each test drives real git and fake `claude`.
 */
import { join } from "node:path";
import { findRepoRoot, runCommand, Store, type CommandRunner, type GithubPort } from "@factory/core";
import { fakeClaude, repoWithRemote, type FakeStep } from "../../../packages/core/test/helpers.js";
import { runRun } from "../src/commands/runs.js";

export const ESC = "\x1b[";
// eslint-disable-next-line no-control-regex -- matching escape characters is the point
export const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

export const TRIAGE = "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- fine\n";
export const BUILD: FakeStep = {
  files: { "feature.txt": "fixed\n" },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", "feat: add feature"],
  ],
  output: "STATUS: READY\nCOMMIT: {{HEAD}}\n\n## Summary\n- done\n",
};

export function setup(steps: FakeStep[], gates = "triage: auto", extraConfig = "") {
  const config = `version: 1\nchecks:\n  - name: ok\n    run: node -e "process.exit(0)"\ntrust:\n  authors: [alice]\ngates:\n  ${gates}\n${extraConfig}`;
  const { root: dir } = repoWithRemote({ "README.md": "# demo\n", ".gitignore": ".factory/runs/\n.factory/factory.db*\n.worktrees/\n", ".factory/config.yaml": config });
  const root = findRepoRoot(dir)!;
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  for (const [number, title] of [
    [12, "Add the feature"],
    [13, "Add another feature"],
  ] as const) {
    store.upsertIssue(project.id, {
      number,
      title,
      body: "Add feature.txt",
      state: "open",
      author: "alice",
      labels: [],
      url: `https://github.com/o/r/issues/${number}`,
      gh_updated_at: "2026-01-01T00:00:00Z",
    });
  }
  store.close();

  const fake = fakeClaude(steps);
  const github: GithubPort = { commentOnIssue: () => undefined, findPullRequest: () => undefined, createDraftPullRequest: () => 7 };
  const printed: string[] = [];
  const queue = (...numbers: number[]) => {
    const s = new Store(join(root, ".factory", "factory.db"));
    for (const n of numbers.length ? numbers : [12]) s.setQueued(project.id, n, true);
    s.close();
  };
  const deps = { env: fake.env, github, print: (l: string) => printed.push(l) };
  const run = (value = "12", extra: { run?: CommandRunner } = {}) => runRun(dir, [value], {}, { ...deps, ...extra });
  const db = () => new Store(join(root, ".factory", "factory.db"));
  return { dir, root, run, queue, printed, fake, deps, db, projectId: project.id };
}

/** Answers `gh issue view` with the given issue; every other command runs for real (git). */
export function fakeGh(issue: { number: number; title: string; state: string; author: string }): CommandRunner {
  return (cmd, args, options) => {
    if (cmd !== "gh") return runCommand(cmd, args, options);
    if (args[0] !== "issue" || args[1] !== "view") return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    const json = {
      number: issue.number,
      title: issue.title,
      body: "Add feature.txt",
      state: issue.state,
      author: { login: issue.author },
      labels: [],
      url: `https://github.com/o/r/issues/${issue.number}`,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    return { code: 0, stdout: JSON.stringify(json), stderr: "" };
  };
}
