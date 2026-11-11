/**
 * Shared setup for the PipelineDriver tests. They are split over several `driver*.test.ts` files so
 * Vitest runs them in parallel: each test drives real git and fake `claude` processes for seconds.
 */
import { Store } from "../src/store/store.js";
import { createAgentRunner } from "../src/agents/runner.js";
import { loadTrustedConfig, trustedReader } from "../src/config/trusted.js";
import { FactoryEvents, type FactoryEvent } from "../src/events.js";
import type { GithubPort } from "../src/github/port.js";
import { PipelineDriver } from "../src/pipeline/driver.js";
import { fakeClaude, repoWithRemote, type FakeStep } from "./helpers.js";

export const TRIAGE = (decision = "APPROVE", extra = "") =>
  `DECISION: ${decision}\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- looks fine\n${extra}`;
export const READY = "STATUS: READY\nCOMMIT: {{HEAD}}\n\n## Summary\n- done\n";

/** A builder round that writes feature.txt and commits it (the engine pushes), then reports READY. */
export const buildStep = (content: string, output = READY): FakeStep => ({
  files: { "feature.txt": `${content}\n` },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", `feat: ${content}`],
  ],
  output,
});

// Built by concatenation so this file contains no secret-shaped string.
export const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";

/** A builder round that commits a change but leaves feature.txt broken, so the gate fails the same way. */
export const sameFailure = (attempt: number): FakeStep => ({
  files: { "feature.txt": "broken\n", "attempt.txt": `${attempt}\n` },
  exec: [
    ["git", "add", "-A"],
    ["git", "commit", "-qm", `fix: attempt ${attempt}`],
  ],
  output: READY,
});

// The gate passes only once feature.txt says "fixed". A failure names the content, plus noise that
// changes every round (commit, timing, worktree path) and must not hide a repeated failure.
const CHECK_JS = `const fs = require("fs");
const content = fs.existsSync("feature.txt") ? fs.readFileSync("feature.txt", "utf8").trim() : "(missing)";
const ok = content === "fixed";
if (!ok) {
  const head = require("child_process").execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  console.error("checked " + head + " in " + (Date.now() % 997) + "ms at " + process.cwd());
  console.error("feature.txt is not fixed yet: " + content);
}
process.exit(ok ? 0 : 1);
`;

export function setup(steps: FakeStep[], options: { author?: string; config?: string } = {}) {
  const config =
    options.config ??
    "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n";
  const { root } = repoWithRemote({
    "README.md": "# demo\n",
    "check.js": CHECK_JS,
    ".gitignore": ".factory/runs/\n.worktrees/\n",
    ".factory/config.yaml": config,
  });
  const fake = fakeClaude(steps);
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  store.upsertIssue(project.id, {
    number: 12,
    title: "Add the feature",
    body: "Please add feature.txt.",
    state: "open",
    author: options.author ?? "alice",
    labels: [],
    url: "https://github.com/o/r/issues/12",
    gh_updated_at: "2026-01-01T00:00:00Z",
  });
  store.setQueued(project.id, 12, true);

  const comments: { issue: number; body: string }[] = [];
  const prs: { head: string; base: string; title: string; body: string }[] = [];
  const github: GithubPort = {
    commentOnIssue: (issue, body) => comments.push({ issue, body }),
    findPullRequest: (branch) => (prs.some((p) => p.head === branch) ? 7 : undefined),
    createDraftPullRequest: (pr) => {
      prs.push(pr);
      return 7;
    },
  };
  const events = new FactoryEvents();
  const seen: FactoryEvent[] = [];
  events.on((e) => seen.push(e));

  const read = trustedReader(root, "main");
  const driver = new PipelineDriver({
    store,
    project,
    config: loadTrustedConfig(read, "main"),
    read,
    runAgent: createAgentRunner({ store, events, env: fake.env }),
    github,
    owner: "test-worker",
    events,
    watchMs: 50,
  });
  return { root, store, project, driver, fake, comments, prs, seen };
}

/** Helpers of the `PipelineDriver > reviews` tests. */
export const reviewConfig = (reviews: string) =>
  `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n${reviews}`;
const finding = (severity: string) =>
  `## Findings\n\`\`\`json\n[{ "id": "code-1", "severity": "${severity}", "file": "feature.txt", "line": 1, "claim": "it says fixed", "evidence": "line 1" }]\n\`\`\`\n`;
export const review = (verdict: string, severity?: string) => `VERDICT: ${verdict}\n\n## Summary\n- reviewed\n\n${severity ? finding(severity) : "## Findings\nNone.\n"}`;
