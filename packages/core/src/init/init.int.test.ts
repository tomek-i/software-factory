import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ROLES, resolveModel, REVIEW_LENSES } from "@factory/shared";
import { loadConfig, parseConfig } from "../config/load.js";
import { listRegistered } from "../registry.js";
import { Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { parseGithubRemote } from "../util/git.js";
import { detectProject } from "./detect.js";
import { ensureGitignore, initRepo, InitError } from "./init.js";
import { renderConfig } from "./template.js";

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
      if (args[0] === "api") return { code: 0, stdout: "alice", stderr: "" };
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
    ["ssh://git@github.com/acme/shop.git/", "acme/shop"],
    ["  git@github.com:acme/shop\n", "acme/shop"],
    ["https://github.com/acme", undefined],
    ["https://github.com/acme/shop//", undefined],
  ])("%s -> %s", (url, expected) => {
    expect(parseGithubRemote(url)).toBe(expected);
  });

  it("parses a long hostile remote quickly", () => {
    const started = Date.now();
    expect(parseGithubRemote(`github.com/${"github.com:!".repeat(50_000)}`)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("ensureGitignore", () => {
  it("appends only missing entries and keeps CRLF line endings", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".gitignore"), "node_modules/\r\n.worktrees/\r\n");

    expect(ensureGitignore(dir)).toEqual([".factory/runs/", ".factory/factory.db*", ".factory/drafts/"]);
    const text = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(text.startsWith("node_modules/\r\n.worktrees/\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(ensureGitignore(dir)).toEqual([]);
  });
});

describe("renderConfig", () => {
  it("shows the recommended models commented out, and uncommenting them changes nothing", () => {
    const text = renderConfig(detectProject(tempDir()));
    const lines = text.split("\n");
    const start = lines.indexOf("# models:");
    const end = lines.indexOf("", start);
    const uncommented = lines.slice(start, end).map((l) => l.replace(/^# /, "")).join("\n");
    expect(start).toBeGreaterThan(-1);
    // Every agent, for every lens and risk, gets the same model and effort either way.
    const everyAgent = (config: ReturnType<typeof parseConfig>) =>
      AGENT_ROLES.flatMap((role) =>
        [undefined, ...REVIEW_LENSES].flatMap((lens) => (["LOW", "HIGH"] as const).map((risk) => resolveModel(config, { role, lens, risk }))),
      );
    const defaults = everyAgent(parseConfig("version: 1\n"));
    expect(everyAgent(parseConfig(`version: 1\n${uncommented}\n`))).toEqual(defaults);
    expect(everyAgent(parseConfig(text))).toEqual(defaults);
  });

  it("spells out the merge settings as their defaults, so open feedback waits for a human", () => {
    const text = renderConfig(detectProject(tempDir()));
    expect(text).toMatch(/^merge:\n {2}method: merge.*\n {2}open_feedback: ask\n/m);
    expect(parseConfig(text).merge).toEqual(parseConfig("version: 1\n").merge);
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
    expect(loadConfig(dir).checks).toEqual([{ name: "test", run: "npm run test", timeout_sec: 900, retries: 1 }]);
    expect(loadConfig(dir).github.status_labels).toBe(false);
    expect(loadConfig(dir).trust).toEqual({ authors: ["alice"], everyone: false });
    // The starter config leaves the models to the recommended defaults, so they improve with updates.
    const config = loadConfig(dir);
    expect(readFileSync(join(dir, ".factory", "config.yaml"), "utf8")).not.toMatch(/^models:/m);
    expect(resolveModel(config, { role: "triage" })).toEqual({ model: "opus", effort: "high" });
    expect(resolveModel(config, { role: "reviewer", lens: "docs" })).toEqual({ model: "haiku", effort: "low" });
    expect(resolveModel(config, { role: "reviewer", lens: "code", risk: "HIGH" })).toEqual({ model: "opus", effort: "high" });
    expect(existsSync(join(dir, ".factory", "lessons.md"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".worktrees/");
    // The only GitHub call is reading who you are, to pre-fill the trusted authors.
    expect(gh.calls).toEqual([["api", "user", "--jq", ".login"]]);
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

    expect(gh.calls.filter((c) => c[0] === "label").map((c) => c[2])).toEqual([
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
    expect(second.steps).toContainEqual({ status: "skipped", message: expect.stringContaining("`factory config reset` brings settings back to the defaults") });
    const store = new Store(join(dir, ".factory", "factory.db"));
    expect(store.listProjects()).toHaveLength(1);
    store.close();
  });

  it("adds the repo to the factory's project list once, however often it runs", () => {
    const dir = gitRepo();
    const registryFile = join(tempDir(), "projects.json");

    const first = initRepo({ cwd: dir, registryFile });
    const second = initRepo({ cwd: dir, registryFile });

    expect(first.steps).toContainEqual({ status: "done", message: "Added to the factory's project list" });
    expect(second.steps).toContainEqual({ status: "skipped", message: "Already in the factory's project list" });
    const listed = listRegistered({ file: registryFile });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ path: first.root, status: "ok" });
  });

  it("uses the user's project list by default", () => {
    const dir = gitRepo();
    const { root } = initRepo({ cwd: dir });
    expect(listRegistered().map((p) => p.path)).toContain(root);
  });

  it("warns rather than fails when the project list can't be written", () => {
    const dir = gitRepo();
    const registryFile = join(tempDir(), "projects.json");
    writeFileSync(registryFile, "{ broken");

    const result = initRepo({ cwd: dir, registryFile });

    const step = result.steps.find((s) => s.message.includes("project list"));
    expect(step).toMatchObject({ status: "warning" });
    expect(step!.message).toContain("is not valid");
    expect(existsSync(join(dir, ".factory", "factory.db"))).toBe(true);
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

  describe("--name", () => {
    it("names a new project instead of the detected name", () => {
      const dir = gitRepo();
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "detected" }));

      initRepo({ cwd: dir, name: "Shop" });

      expect(loadConfig(dir).project.name).toBe("Shop");
      const store = new Store(join(dir, ".factory", "factory.db"));
      expect(store.listProjects()).toMatchObject([{ name: "Shop" }]);
      store.close();
    });

    it("renames an existing project, keeping the rest of the config byte for byte", () => {
      const dir = gitRepo();
      const registryFile = join(tempDir(), "projects.json");
      initRepo({ cwd: dir, registryFile });
      const configFile = join(dir, ".factory", "config.yaml");
      const before = readFileSync(configFile, "utf8");
      const oldName = loadConfig(dir).project.name!;

      const result = initRepo({ cwd: dir, registryFile, name: "Renamed" });

      expect(readFileSync(configFile, "utf8")).toBe(before.replace(JSON.stringify(oldName), '"Renamed"'));
      expect(result.steps).toContainEqual({ status: "done", message: 'Set project.name to "Renamed" in .factory/config.yaml' });
      expect(result.steps).toContainEqual({ status: "done", message: "Updated its name in the factory's project list" });
      expect(listRegistered({ file: registryFile })[0]).toMatchObject({ name: "Renamed" });
    });

    it("keeps CRLF line endings when it renames", () => {
      const dir = gitRepo();
      initRepo({ cwd: dir });
      const configFile = join(dir, ".factory", "config.yaml");
      const crlf = readFileSync(configFile, "utf8").replace(/\n/g, "\r\n");
      writeFileSync(configFile, crlf);

      initRepo({ cwd: dir, name: "Renamed", labels: true });

      const after = readFileSync(configFile, "utf8");
      expect(after).not.toMatch(/[^\r]\n/);
      expect(after).toContain('name: "Renamed"\r\n');
      expect(after).toContain("status_labels: true\r\n");
    });

    it("refuses an empty name", () => {
      expect(() => initRepo({ cwd: gitRepo(), name: " " })).toThrow(InitError);
    });

    it("writes nothing when the existing config has no name to set", () => {
      const dir = gitRepo();
      initRepo({ cwd: dir });
      const configFile = join(dir, ".factory", "config.yaml");
      writeFileSync(configFile, "version: 1\n");

      expect(() => initRepo({ cwd: dir, name: "Shop" })).toThrow(/project\.name: not in the file/);
      expect(readFileSync(configFile, "utf8")).toBe("version: 1\n");
    });
  });

  describe("--labels", () => {
    it("turns status labels on in a new config and creates them", () => {
      const dir = gitRepo("https://github.com/acme/shop.git");
      const gh = withFakeGh();

      const result = initRepo({ cwd: dir, run: gh.run, labels: true });

      expect(loadConfig(dir).github.status_labels).toBe(true);
      expect(gh.calls.filter((c) => c[0] === "label")).toHaveLength(5);
      expect(result.steps.at(-1)).toEqual({ status: "done", message: "Created factory labels on acme/shop" });
    });

    it("turns them on in an existing config", () => {
      const dir = gitRepo("https://github.com/acme/shop.git");
      initRepo({ cwd: dir, run: withFakeGh().run });
      const gh = withFakeGh();

      const result = initRepo({ cwd: dir, run: gh.run, labels: true });

      expect(readFileSync(join(dir, ".factory", "config.yaml"), "utf8")).toContain("  status_labels: true\n");
      expect(result.steps).toContainEqual({ status: "done", message: "Set github.status_labels to true in .factory/config.yaml" });
      expect(gh.calls.filter((c) => c[0] === "label")).toHaveLength(5);
    });

    it("leaves a config that already has them on unchanged", () => {
      const dir = gitRepo();
      withStatusLabels(dir);

      const result = initRepo({ cwd: dir, labels: true });

      expect(result.steps[0]).toMatchObject({ status: "skipped", message: expect.stringContaining("left unchanged") });
    });
  });

  describe("--dry-run", () => {
    it("writes nothing in a new repo and says what it would do", () => {
      const dir = gitRepo("https://github.com/acme/shop.git");
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
      const registryFile = join(tempDir(), "projects.json");
      const gh = withFakeGh();

      const result = initRepo({ cwd: dir, run: gh.run, registryFile, labels: true, dryRun: true });

      expect(existsSync(join(dir, ".factory"))).toBe(false);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n");
      expect(existsSync(registryFile)).toBe(false);
      expect(gh.calls.filter((c) => c[0] === "label")).toEqual([]);
      expect(result.steps.map((s) => s.message)).toEqual([
        "Would write .factory/config.yaml (checks: none - add them by hand)",
        "Would write .factory/lessons.md",
        "Would add .factory/runs/, .factory/factory.db*, .worktrees/, .factory/drafts/ to .gitignore",
        "Would register project in .factory/factory.db",
        "Would add it to the factory's project list",
        "Would create factory labels on acme/shop",
      ]);
    });

    it("writes nothing in a set-up repo, and reports the changes it would make", () => {
      const dir = gitRepo();
      const registryFile = join(tempDir(), "projects.json");
      initRepo({ cwd: dir, registryFile });
      const configFile = join(dir, ".factory", "config.yaml");
      const before = readFileSync(configFile, "utf8");

      const result = initRepo({ cwd: dir, registryFile, name: "Renamed", dryRun: true });

      expect(readFileSync(configFile, "utf8")).toBe(before);
      expect(listRegistered({ file: registryFile })[0]!.name).not.toBe("Renamed");
      expect(result.steps).toContainEqual({ status: "done", message: 'Would set project.name to "Renamed" in .factory/config.yaml' });
      expect(result.steps).toContainEqual({ status: "done", message: "Would update its name in the factory's project list" });
      expect(result.steps).toContainEqual({ status: "skipped", message: ".gitignore already ignores factory state" });
    });
  });
});
