import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = join(here, "fake-claude.mjs");

export interface FakeStep {
  /** Only this role's agent takes the step (the system prompt file name, e.g. "reviewer-code"). */
  role?: string;
  stream?: "success" | "error_max_turns" | "rate_limited";
  files?: Record<string, string>;
  exec?: string[][];
  output?: string;
  exitCode?: number;
  sleepMs?: number;
}

/** A review that passes with no findings. */
export const REVIEW_PASS = "VERDICT: PASS\n\n## Summary\n- looks good\n\n## Findings\nNone.\n";

/** One passing review per lens; the default lenses are `reviews.always` (code, security, docs). */
export const reviewsPass = (lenses: string[] = ["code", "security", "docs"]): FakeStep[] =>
  lenses.map((lens) => ({ role: `reviewer-${lens}`, output: REVIEW_PASS }));

export interface FakeInvocation {
  argv: string[];
  cwd: string;
  stdin: string;
  role: string;
  hasApiKey: boolean;
}

export function tempDir(prefix = "factory-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A scripted fake `claude`: env to pass to the runner, plus a way to read what it was called with. */
export function fakeClaude(steps: FakeStep[]) {
  const dir = tempDir("fake-claude-");
  const scenario = join(dir, "scenario.json");
  const log = join(dir, "calls.jsonl");
  writeFileSync(scenario, JSON.stringify({ steps }));
  return {
    env: {
      ...process.env,
      FACTORY_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_SCENARIO: scenario,
      FAKE_CLAUDE_LOG: log,
    } as NodeJS.ProcessEnv,
    calls(): FakeInvocation[] {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as FakeInvocation);
    },
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A real repository with a bare "origin", one commit on main, pushed. Identity is set locally so
 * commits work on machines without a global git config.
 */
export function repoWithRemote(files: Record<string, string> = { "README.md": "# demo\n" }) {
  const base = tempDir("factory-repo-");
  const remote = join(base, "remote.git");
  const root = join(base, "work");
  mkdirSync(root);
  git(base, "init", "--bare", "-b", "main", remote);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "factory@example.invalid");
  git(root, "config", "user.name", "Factory Test");
  git(root, "config", "core.autocrlf", "false");
  git(root, "remote", "add", "origin", remote);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial");
  git(root, "push", "-u", "origin", "main");
  return { root, remote, base };
}
