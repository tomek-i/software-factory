import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, type CommandRunner } from "@factory/core";
import { runInit } from "./init.js";

function repo(remote = false): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-cli-"));
  runCommand("git", ["init", "-q"], { cwd: dir });
  if (remote) runCommand("git", ["remote", "add", "origin", "https://github.com/acme/shop.git"], { cwd: dir });
  return dir;
}

/** Real git, fake gh logged in as alice, listing one open issue, or failing to list when `listFails`. */
function fakeGh(listFails = false): CommandRunner {
  return (cmd, args, opts) => {
    if (cmd !== "gh") return runCommand(cmd, args, opts);
    if (args[0] === "api") return { code: 0, stdout: "alice", stderr: "" };
    if (args[1] === "list") {
      if (listFails) return { code: 1, stdout: "", stderr: "gh: not logged in" };
      const issue = { number: 1, title: "Issue 1", body: "", state: "OPEN", author: { login: "alice" }, labels: [], url: "https://github.com/acme/shop/issues/1", updatedAt: "2026-11-01T00:00:00Z" };
      return { code: 0, stdout: JSON.stringify([issue]), stderr: "" };
    }
    return { code: 0, stdout: "[]", stderr: "" };
  };
}

describe("runInit", () => {
  it("prints each step and the next action", () => {
    const output = runInit(repo());

    expect(output).toMatch(/^Initialised software factory in /);
    expect(output).toContain("+ Wrote .factory/config.yaml");
    expect(output).toContain("- GitHub status labels (off;");
    expect(output).toContain("Next: review .factory/config.yaml");
    expect(output).toContain("then run `factory sync` to pull issues");
  });

  it("does not sync without --sync", () => {
    const output = runInit(repo(true), fakeGh());

    expect(output).not.toContain("Synced");
  });

  it("pulls issues with --sync", () => {
    const output = runInit(repo(true), fakeGh(), undefined, { sync: true });

    expect(output).toContain("+ Synced acme/shop: 1 open, 0 closed since last sync, 0 queued.");
    expect(output).not.toContain("factory sync");
  });

  it("passes --name and --labels through to the config", () => {
    const dir = repo(true);

    const output = runInit(dir, fakeGh(), undefined, { name: "Shop", labels: true });

    expect(output).toContain("+ Created factory labels on acme/shop");
    const config = readFileSync(join(dir, ".factory", "config.yaml"), "utf8");
    expect(config).toContain('name: "Shop"');
    expect(config).toContain("status_labels: true");
  });

  it("writes and syncs nothing on --dry-run", () => {
    const dir = repo(true);

    const output = runInit(dir, fakeGh(), undefined, { dryRun: true, sync: true });

    expect(output).toMatch(/^Dry run in .*: nothing was written/);
    expect(output).toContain("+ Would write .factory/config.yaml");
    expect(output).toContain("+ Would sync issues from GitHub");
    expect(output).toContain("Next: run it again without --dry-run to apply.");
    expect(existsSync(join(dir, ".factory"))).toBe(false);
  });

  it("still initialises when --sync fails, and says so", () => {
    const output = runInit(repo(true), fakeGh(true), undefined, { sync: true });

    expect(output).toContain("+ Wrote .factory/config.yaml");
    expect(output).toMatch(/! Could not sync issues: .*not logged in/);
    expect(output).toContain("then run `factory sync` to pull issues");
  });
});
