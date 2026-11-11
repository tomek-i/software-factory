import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

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

/**
 * Test timeout for files whose tests drive real git repos and child processes: seconds each on
 * Windows, and many times that while the machine is busy (another `pnpm test`). Use it with
 * `vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT })`; tests that prove something is fast keep their
 * own, tighter limits.
 */
export const GIT_TEST_TIMEOUT = 120_000;

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
 *
 * Building one takes about ten git processes (seconds on Windows), so each distinct set of files is
 * built once as a template and every call gets its own copy, with `origin` pointed at the copy's
 * own `remote.git`. A copy shares nothing with the template or with other copies.
 */
export function repoWithRemote(files: Record<string, string> = { "README.md": "# demo\n" }) {
  const base = tempDir("factory-repo-");
  cpSync(repoTemplate(files), base, { recursive: true });
  const remote = join(base, "remote.git");
  const root = join(base, "work");
  setOriginUrl(root, remote);
  return { root, remote, base };
}

declare module "vitest" {
  export interface ProvidedContext {
    /** Directory shared by every test file of a run for repo templates (see global-setup.ts). */
    repoTemplates: string;
  }
}

const templates = new Map<string, string>();
let localTemplates: string | undefined;

/** The directory holding a built `remote.git` + `work` pair for `files`, building it on first use. */
function repoTemplate(files: Record<string, string>): string {
  const key = createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest("hex")
    .slice(0, 16);
  const known = templates.get(key);
  if (known) return known;
  // Shared by all test files of the run when the global setup ran, else private to this file.
  const shared = inject("repoTemplates") ?? (localTemplates ??= tempDir("factory-templates-"));
  const target = join(shared, key);
  // A template only appears under its key by an atomic rename once it is complete.
  if (!existsSync(target)) {
    const building = mkdtempSync(join(shared, "building-"));
    buildRepo(building, files);
    try {
      renameSync(building, target);
    } catch {
      // Another test file finished the same template first, or Windows held a handle: either
      // way `building` is a complete template of its own.
      templates.set(key, existsSync(target) ? target : building);
      return templates.get(key)!;
    }
  }
  templates.set(key, target);
  return target;
}

function buildRepo(base: string, files: Record<string, string>): void {
  const remote = join(base, "remote.git");
  const root = join(base, "work");
  // No sample hooks: fewer files to copy for every test.
  const noTemplate = join(base, "no-template");
  mkdirSync(noTemplate);
  mkdirSync(root);
  git(base, "init", "-q", `--template=${noTemplate}`, "--bare", "-b", "main", remote);
  git(root, "init", "-q", `--template=${noTemplate}`, "-b", "main");
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
  rmSync(noTemplate, { recursive: true });
}

/** Points `origin` (the template's only remote) of the repo at `root` to `remote`, without a git process. */
function setOriginUrl(root: string, remote: string): void {
  const config = join(root, ".git", "config");
  const text = readFileSync(config, "utf8");
  const url = /^([ \t]*url = ).*$/gm;
  if (text.match(url)?.length !== 1) throw new Error(`expected exactly one remote url in ${config}`);
  // A quoted git config value, so no character of a temp path can be read as syntax.
  const quoted = `"${remote.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  writeFileSync(config, text.replace(url, (_, prefix: string) => prefix + quoted));
}
