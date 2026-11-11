import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { parseGithubRemote } from "../util/git.js";
import { detectProject } from "./detect.js";
import { ensureGitignore, initRepo, InitError } from "./init.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "factory-init-"));
}

function gitRepo(remote?: string): string {
  const dir = tempDir();
  runCommand("git", ["init", "-q"], { cwd: dir });
  if (remote) runCommand("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

function withStatusLabels(dir: string): void {
  mkdirSync(join(dir, ".factory"), { recursive: true });
  writeFileSync(join(dir, ".factory", "config.yaml"), "version: 1\ngithub:\n  status_labels: true\n");
}

/** Real git, recorded fake gh. */
function withFakeGh(ghCode = 0) {
  const calls: string[][] = [];
  const run: CommandRunner = (cmd, args, opts) => {
    if (cmd === "gh") {
      calls.push(args);
      return { code: ghCode, stdout: "", stderr: ghCode ? "HTTP 403" : "" };
    }
    return runCommand(cmd, args, opts);
  };
  return { run, calls };
}

describe("detectProject", () => {
  it("maps package.json scripts to checks using the lockfile's package manager", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "shop", scripts: { test: "vitest", "type-check": "tsc", lint: "eslint .", dev: "vite" } }),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");

    expect(detectProject(dir)).toEqual({
      stacks: ["node"],
      projectName: "shop",
      appStart: "pnpm run dev",
      checks: [
        { name: "lint", run: "pnpm run lint" },
        { name: "typecheck", run: "pnpm run type-check" },
        { name: "test", run: "pnpm run test" },
      ],
    });
  });

  it("detects several stacks and keeps duplicate check names apart", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" } }));
    writeFileSync(join(dir, "App.sln"), "");

    const detection = detectProject(dir);
    expect(detection.stacks).toEqual(["node", "dotnet"]);
    expect(detection.checks.map((c) => c.name)).toEqual(["build", "build-dotnet", "test"]);
  });

  it("falls back to the folder name with no checks for an unknown stack", () => {
    const dir = tempDir();
    const detection = detectProject(dir);
    expect(detection.checks).toEqual([]);
    expect(detection.projectName).toMatch(/^factory-init-/);
  });
});

describe("parseGithubRemote", () => {
  it.each([
    ["https://github.com/acme/shop.git", "acme/shop"],
    ["git@github.com:acme/shop.git", "acme/shop"],
    ["https://github.com/acme/shop", "acme/shop"],
    ["https://gitlab.com/acme/shop.git", undefined],
  ])("%s -> %s", (url, expected) => {
    expect(parseGithubRemote(url)).toBe(expected);
  });
});

describe("ensureGitignore", () => {
  it("appends only missing entries and keeps CRLF line endings", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\r\n.worktrees/\r\n");

    expect(ensureGitignore(dir)).toEqual([".factory/runs/", ".factory/factory.db*"]);
    const text = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(text.startsWith("node_modules/\r\n.worktrees/\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(ensureGitignore(dir)).toEqual([]);
  });
});

describe("initRepo", () => {
  it("refuses to run outside a git repository", () => {
    expect(() => initRepo({ cwd: tempDir() })).toThrow(InitError);
  });

  it("sets up config, lessons, gitignore and db without touching GitHub by default", () => {
    const dir = gitRepo("https://github.com/acme/shop.git");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop", scripts: { test: "vitest" } }));
    const gh = withFakeGh();

    const result = initRepo({ cwd: dir, run: gh.run });

    expect(result.githubRepo).toBe("acme/shop");
    expect(loadConfig(dir).checks).toEqual([{ name: "test", run: "npm run test", timeout_sec: 900 }]);
    expect(loadConfig(dir).github.status_labels).toBe(false);
    expect(existsSync(join(dir, ".factory", "lessons.md"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".worktrees/");
    expect(gh.calls).toEqual([]);
    expect(result.steps.at(-1)).toMatchObject({ status: "skipped" });

    const store = new Store(join(dir, ".factory", "factory.db"));
    expect(store.listProjects()).toMatchObject([{ name: "shop", github_repo: "acme/shop" }]);
    store.close();
  });

  it("creates status labels once they are enabled in config", () => {
    const dir = gitRepo("https://github.com/acme/shop.git");
    withStatusLabels(dir);
    const gh = withFakeGh();

    initRepo({ cwd: dir, run: gh.run });

    expect(gh.calls.map((c) => c[2])).toEqual([
      "factory",
      "factory:in-progress",
      "factory:needs-info",
      "factory:needs-human",
      "factory:unsafe",
    ]);
    expect(gh.calls[0]).toContain("acme/shop");
  });

  it("is safe to re-run and never overwrites an existing config", () => {
    const dir = gitRepo();
    initRepo({ cwd: dir });
    const configFile = join(dir, ".factory", "config.yaml");
    writeFileSync(configFile, "version: 1\nproject:\n  name: hand-edited\n");

    const second = initRepo({ cwd: dir });

    expect(readFileSync(configFile, "utf8")).toContain("hand-edited");
    expect(second.steps.map((s) => s.status)).toContain("skipped");
    const store = new Store(join(dir, ".factory", "factory.db"));
    expect(store.listProjects()).toHaveLength(1);
    store.close();
  });

  it("reports an invalid existing config instead of ignoring it", () => {
    const dir = gitRepo();
    initRepo({ cwd: dir });
    writeFileSync(join(dir, ".factory", "config.yaml"), "version: 1\ngates:\n  merge: maybe\n");
    expect(() => initRepo({ cwd: dir })).toThrow(/gates\.merge/);
  });

  it("warns rather than fails when labels cannot be created", () => {
    const dir = gitRepo("git@github.com:acme/shop.git");
    withStatusLabels(dir);
    const result = initRepo({ cwd: dir, run: withFakeGh(1).run });
    expect(result.steps.at(-1)).toMatchObject({ status: "warning" });
    expect(result.steps.at(-1)!.message).toContain("HTTP 403");
  });

  it("skips labels when there is no GitHub remote", () => {
    const dir = gitRepo();
    withStatusLabels(dir);
    const gh = withFakeGh();
    const result = initRepo({ cwd: dir, run: gh.run });
    expect(gh.calls).toEqual([]);
    expect(result.steps.at(-1)).toMatchObject({ status: "warning" });
  });
});
