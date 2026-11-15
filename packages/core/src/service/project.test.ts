import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { initRepo } from "../init/init.js";
import { Store } from "../store/store.js";
import { runCommand } from "../util/exec.js";
import { ServiceError } from "./errors.js";
import { openProject, openRegisteredProject } from "./project.js";

function initialised(): string {
  const dir = tempDir("factory-project-");
  runCommand("git", ["init", "-q"], { cwd: dir });
  return initRepo({ cwd: dir }).root;
}

describe("openProject", () => {
  it("opens the repo containing cwd", () => {
    const root = initialised();
    mkdirSync(join(root, "src"));
    const ctx = openProject(join(root, "src"));
    try {
      expect(ctx.root).toBe(root);
      expect(ctx.project.repo_path).toBe(root);
    } finally {
      ctx.store.close();
    }
  });

  it("refuses a folder outside git, and a repo with a config but no database", () => {
    expect(() => openProject(tempDir())).toThrow(new ServiceError("Not inside a git repository."));
    const bare = tempDir();
    runCommand("git", ["init", "-q"], { cwd: bare });
    mkdirSync(join(bare, ".factory"));
    writeFileSync(join(bare, ".factory", "config.yaml"), "version: 1\n");
    expect(() => openProject(bare)).toThrow(/not registered. Run `factory init` first/);
    expect(existsSync(join(bare, ".factory", "factory.db"))).toBe(false);
  });
});

describe("openRegisteredProject", () => {
  it("opens a project from its entry in the project list", () => {
    const root = initialised();
    const ctx = openRegisteredProject({ path: root });
    try {
      expect(ctx.project.repo_path).toBe(root);
      expect(ctx.config.version).toBe(1);
    } finally {
      ctx.store.close();
    }
  });

  it("reports a repo that has gone", () => {
    const gone = join(tempDir(), "deleted");
    expect(() => openRegisteredProject({ path: gone })).toThrow(/no longer exists/);
    expect(existsSync(gone)).toBe(false);
  });

  it("reports a database that doesn't know the repo", () => {
    const root = initialised();
    const store = new Store(join(root, ".factory", "factory.db"));
    store.db.prepare("DELETE FROM projects").run();
    store.close();
    expect(() => openRegisteredProject({ path: root })).toThrow(/is not set up in its \.factory\/factory\.db/);
    expect(() => openProject(root)).toThrow(/not registered. Run `factory init` first/);
  });

  it("reports a missing database without creating one", () => {
    const root = tempDir();
    expect(() => openRegisteredProject({ path: root })).toThrow(/has no .factory\/factory.db/);
    expect(existsSync(join(root, ".factory", "factory.db"))).toBe(false);
  });
});
