import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listRegistered, registerProject } from "@factory/core";
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
    expect(runProjects(setup().opts)).toBe("No projects registered. Run `factory init` in a repository.");
  });

  it("lists each project, flagging a missing folder or database", () => {
    const { dir, opts } = setup();
    const shop = initialisedRepo(dir, "shop");
    const bare = join(dir, "bare");
    mkdirSync(bare);
    registerProject({ path: shop, name: "shop" }, opts);
    registerProject({ path: bare, name: "bare" }, opts);
    registerProject({ path: join(dir, "gone"), name: "gone" }, opts);

    expect(runProjects(opts).split("\n")).toEqual([
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

  it("fails as a CLI error for a path that is not listed", () => {
    const { dir, opts } = setup();
    expect(() => runProjectsRemove(dir, "nope", opts)).toThrow(CliError);
    expect(() => runProjectsRemove(dir, "nope", opts)).toThrow(`Not in the project list: ${join(dir, "nope")}`);
  });
});
