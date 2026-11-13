import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../../../packages/core/test/helpers.js";
import { buildProgram } from "./program.js";
import { CLI_FILE, refuseRunningOnItself } from "./self.js";

const REFUSED = /inside the repository it would change\. Run it from a pinned copy/;

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-self-"));
  git(dir, "init", "--quiet");
  return dir;
}

function cliAt(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.js");
  writeFileSync(file, "");
  return file;
}

describe("refuseRunningOnItself", () => {
  it("refuses a copy inside the repository, also in one of its worktrees", () => {
    const root = repo();
    expect(() => refuseRunningOnItself(root, cliAt(join(root, "apps", "cli", "dist")))).toThrow(REFUSED);
    expect(() => refuseRunningOnItself(join(root, "apps"), cliAt(join(root, ".worktrees", "12-x", "apps", "cli", "dist")))).toThrow(REFUSED);
  });

  it("allows a copy outside the repository, also one in a folder whose name starts the same", () => {
    const root = repo();
    expect(() => refuseRunningOnItself(root, cliAt(join(mkdtempSync(join(tmpdir(), "factory-pinned-")), "dist")))).not.toThrow();
    expect(() => refuseRunningOnItself(root, cliAt(`${root}-pinned`))).not.toThrow();
  });

  it.runIf(process.platform === "win32")("sees through a different letter case on Windows", () => {
    const root = repo();
    expect(() => refuseRunningOnItself(root.toUpperCase(), cliAt(join(root, "dist")).toLowerCase())).toThrow(REFUSED);
  });

  it("refuses `factory run` when run from source inside this repository", async () => {
    // These tests run from this repository's own source, the case the check is for.
    expect(() => refuseRunningOnItself(join(CLI_FILE, ".."))).toThrow(REFUSED);
    const program = buildProgram().exitOverride();
    const cwd = process.cwd();
    process.chdir(join(CLI_FILE, ".."));
    try {
      await expect(program.parseAsync(["node", "factory", "run", "89"])).rejects.toThrow(REFUSED);
    } finally {
      process.chdir(cwd);
    }
  });
});
