import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git, repoWithRemote } from "../../test/helpers.js";
import { parseConfig } from "../config/load.js";
import { ServiceError } from "./errors.js";
import type { ProjectContext } from "./project.js";
import { readSettings, saveSettings, SettingsChanged } from "./settings.js";

const CONFIG = `version: 1
project:
  name: shop
# Where runs stop for you.
gates:
  merge: human
trust:
  authors: [alice]
`;

function project(config = CONFIG) {
  const { root, remote } = repoWithRemote({ "README.md": "# shop\n", ".factory/config.yaml": config });
  // Only the working copy's default branch is read from the context.
  const ctx = { root, config: parseConfig(CONFIG) } as unknown as ProjectContext;
  return { root, remote, ctx };
}

describe("readSettings", () => {
  it("reads the settings from the remote default branch, at its commit, with what the file sets", () => {
    const { root, ctx } = project();
    const settings = readSettings(ctx);

    expect(settings).toMatchObject({ branch: "main", head: git(root, "rev-parse", "origin/main"), problems: [] });
    const at = (path: string) => settings.settings.find((s) => s.path === path)!;
    expect(at("gates.merge")).toMatchObject({ value: "human", effective: "human", default: "human", sensitive: expect.any(String) });
    expect(at("gates.triage")).toMatchObject({ value: undefined, effective: "auto", default: "auto" });
    expect(at("trust.authors")).toMatchObject({ value: ["alice"], effective: ["alice"], default: [] });
    expect(at("project.default_branch").readOnly).toBeTruthy();
    expect(settings.builtinPaths).toContain(".factory/**");
  });

  it("shows the defaults, and why, when the file on the branch is not a valid config", () => {
    const { ctx } = project("version: 1\nloops:\n  max_review_rounds: 0\n");
    const settings = readSettings(ctx);
    expect(settings.problems).toEqual(["origin/main:.factory/config.yaml: loops.max_review_rounds: Too small: expected number to be >=1"]);
    expect(settings.settings.find((s) => s.path === "loops.max_review_rounds")).toMatchObject({ value: 0, effective: 3 });
  });
});

describe("saveSettings", () => {
  it("commits the change to the default branch and pushes it, keeping the file's comments", () => {
    const { root, ctx } = project();
    const head = readSettings(ctx).head;

    const saved = saveSettings(ctx, { head, changes: [{ path: "gates.merge", value: "auto" }, { path: "loops.max_review_rounds", value: 4 }, { path: "trust.authors", reset: true }] });

    git(root, "fetch", "-q", "origin");
    expect(saved).toMatchObject({ branch: "main", commit: git(root, "rev-parse", "origin/main"), changed: ["gates.merge", "loops.max_review_rounds", "trust.authors"] });
    expect(saved.config.gates.merge).toBe("auto");
    expect(git(root, "log", "-1", "--format=%s", "origin/main")).toBe("chore(factory): change settings: gates.merge, loops.max_review_rounds, trust.authors");
    expect(git(root, "rev-parse", "origin/main^")).toBe(head);
    const text = git(root, "show", "origin/main:.factory/config.yaml");
    expect(text).toContain("# Where runs stop for you.");
    expect(parseConfig(text)).toMatchObject({ gates: { merge: "auto" }, loops: { max_review_rounds: 4 }, trust: { authors: [] } });
    // No worktree or branch is left behind, and the working copy is untouched.
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("refuses when the branch moved since the settings were read, and changes nothing", () => {
    const { root, ctx } = project();
    const stale = readSettings(ctx).head;
    saveSettings(ctx, { head: stale, changes: [{ path: "gates.merge", value: "auto" }] });
    git(root, "fetch", "-q", "origin");
    const now = git(root, "rev-parse", "origin/main");

    expect(() => saveSettings(ctx, { head: stale, changes: [{ path: "gates.pr", value: "human" }] })).toThrow(SettingsChanged);
    git(root, "fetch", "-q", "origin");
    expect(git(root, "rev-parse", "origin/main")).toBe(now);
  });

  it("says the branch refused the push, and leaves nothing behind", () => {
    const { root, remote, ctx } = project();
    const head = readSettings(ctx).head;
    const hook = join(remote, "hooks", "pre-receive");
    mkdirSync(join(remote, "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho 'protected branch' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    expect(() => saveSettings(ctx, { head, changes: [{ path: "gates.merge", value: "auto" }] })).toThrow(/^main refused the push, so nothing was changed .*protected branch/s);
    git(root, "fetch", "-q", "origin");
    expect(git(root, "rev-parse", "origin/main")).toBe(head);
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("keeps the repository's commit hooks, and says when one refused", () => {
    const { root, ctx } = project();
    const head = readSettings(ctx).head;
    const hooks = join(root, "..", "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    git(root, "config", "core.hooksPath", hooks);

    expect(() => saveSettings(ctx, { head, changes: [{ path: "gates.merge", value: "auto" }] })).toThrow(/refused the settings commit \(they are never skipped\), so nothing was pushed/);
  });

  it("refuses an unknown or read-only setting, or a value the config rejects, before committing anything", () => {
    const { root, ctx } = project();
    const head = readSettings(ctx).head;
    expect(() => saveSettings(ctx, { head, changes: [] })).toThrow(new ServiceError("No settings to change."));
    expect(() => saveSettings(ctx, { head, changes: [{ path: "gates.nope", value: "auto" }] })).toThrow(new ServiceError("gates.nope is not a setting."));
    expect(() => saveSettings(ctx, { head, changes: [{ path: "project.default_branch", value: "dev" }] })).toThrow(/can't be changed here/);
    expect(() => saveSettings(ctx, { head, changes: [{ path: "loops.max_review_rounds", value: 0 }] })).toThrow(/loops\.max_review_rounds: Too small/);
    git(root, "fetch", "-q", "origin");
    expect(git(root, "rev-parse", "origin/main")).toBe(head);
  });
});
