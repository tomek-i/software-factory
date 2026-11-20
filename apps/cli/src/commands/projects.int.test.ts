import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, listRegistered, registerProject, runCommand } from "@factory/core";
import { CliError } from "../context.js";
import { runProjects, runProjectsRemove } from "./projects.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "factory-cli-"));
  return { dir, opts: { file: join(dir, "projects.json") } };
}

function initialisedRepo(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, ".factory"), { recursive: true });
  writeFileSync(join(root, ".factory", "factory.db"), "");
  return root;
}

describe("runProjects", () => {
  it("says how to add one when the list is empty", () => {
    const { dir, opts } = setup();
    expect(runProjects(dir, opts)).toBe("No projects registered. Run `factory init` in a repository.");
  });

  it("names the repo it is run in when that has a database but is not in the list, and adds nothing", () => {
    const { dir, opts } = setup();
    const repo = initialisedRepo(dir, "shop");
    runCommand("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "src"));
    const hint = `This repository (${resolve(findRepoRoot(repo)!)}) has a factory database but is not in your project list. Run \`factory init\` here to add it (your config is kept).`;

    expect(runProjects(join(repo, "src"), opts)).toBe(hint);

    const other = initialisedRepo(dir, "blog");
    registerProject({ path: other, name: "blog" }, opts);
    expect(runProjects(repo, opts)).toBe(`blog  ${other}\n\n${hint}`);
    expect(listRegistered(opts).map((p) => p.name)).toEqual(["blog"]);
  });

  it("says nothing more for a listed repo, or a repo without a database", () => {
    const { dir, opts } = setup();
    const folder = initialisedRepo(dir, "shop");
    runCommand("git", ["init", "-q"], { cwd: folder });
    // Registered as `factory init` does, by git's path: a temp folder's short (8.3) name on Windows would not match it.
    const repo = resolve(findRepoRoot(folder)!);
    registerProject({ path: repo, name: "shop" }, opts);
    const bare = join(dir, "bare");
    mkdirSync(bare);
    runCommand("git", ["init", "-q"], { cwd: bare });

    expect(runProjects(repo, opts)).toBe(`shop  ${repo}`);
    expect(runProjects(bare, opts)).toBe(`shop  ${repo}`);
  });

  it("lists each project, flagging a missing folder or database", () => {
    const { dir, opts } = setup();
    const shop = initialisedRepo(dir, "shop");
    const bare = join(dir, "bare");
    mkdirSync(bare);
    registerProject({ path: shop, name: "shop" }, opts);
    registerProject({ path: bare, name: "bare" }, opts);
    registerProject({ path: join(dir, "gone"), name: "gone" }, opts);

    expect(runProjects(dir, opts).split("\n")).toEqual([
      `shop  ${shop}`,
      `bare  ${bare}  (not initialised: no .factory/factory.db)`,
      `gone  ${join(dir, "gone")}  (folder missing)`,
    ]);
  });
});

describe("runProjectsRemove", () => {
  it("drops a project given a path relative to cwd", () => {
    const { dir, opts } = setup();
    const shop = initialisedRepo(dir, "shop");
    registerProject({ path: shop, name: "shop" }, opts);

    expect(runProjectsRemove(dir, "shop", opts)).toBe(
      `Removed ${shop} from the project list (the repository and its database are untouched).`,
    );
    expect(listRegistered(opts)).toEqual([]);
  });

  it("takes a folder inside a repo to mean that repo", () => {
    const { dir, opts } = setup();
    const repo = initialisedRepo(dir, "shop");
    runCommand("git", ["init", "-q"], { cwd: repo });
    const root = findRepoRoot(repo)!;
    mkdirSync(join(repo, "src"));
    registerProject({ path: root, name: "shop" }, opts);

    expect(runProjectsRemove(join(repo, "src"), ".", opts)).toBe(
      `Removed ${root} from the project list (the repository and its database are untouched).`,
    );
  });

  it("fails as a CLI error for a path that is not listed", () => {
    const { dir, opts } = setup();
    expect(() => runProjectsRemove(dir, "nope", opts)).toThrow(CliError);
    expect(() => runProjectsRemove(dir, "nope", opts)).toThrow(`Not in the project list: ${join(dir, "nope")}`);
  });
});
