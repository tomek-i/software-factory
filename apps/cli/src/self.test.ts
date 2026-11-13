import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { git } from "../../../packages/core/test/helpers.js";
import * as newCommand from "./commands/new.js";
import * as runs from "./commands/runs.js";
import { buildProgram } from "./program.js";
import { CLI_FILE, refuseRunningOnItself } from "./self.js";

// Stubbed so that a broken check fails the test instead of driving real runs of this repository.
vi.mock("./commands/runs.js", () => ({
  runApprove: vi.fn(async () => "recorded"),
  runCancel: vi.fn(),
  runLogs: vi.fn(),
  runReject: vi.fn(),
  runResume: vi.fn(),
  runRun: vi.fn(),
  runStatus: vi.fn(),
}));
vi.mock("./commands/new.js", () => ({ runNew: vi.fn() }));

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

  it("refuses the commands that drive runs when run from source inside this repository", async () => {
    // These tests run from this repository's own source, the case the check is for.
    expect(() => refuseRunningOnItself(join(CLI_FILE, ".."))).toThrow(REFUSED);
    const cwd = process.cwd();
    process.chdir(join(CLI_FILE, ".."));
    try {
      for (const args of [["run", "89"], ["approve", "89"], ["resume", "89", "--to", "build", "-m", "x"], ["new", "an idea"]]) {
        await expect(buildProgram().exitOverride().parseAsync(["node", "factory", ...args])).rejects.toThrow(REFUSED);
      }
      // Only recording a decision drives nothing.
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await buildProgram().exitOverride().parseAsync(["node", "factory", "approve", "89", "--no-run"]);
      expect(runs.runApprove).toHaveBeenCalledOnce();
    } finally {
      process.chdir(cwd);
    }
    // The commands must never get past the check here: a registered checkout would start real runs.
    expect(runs.runRun).not.toHaveBeenCalled();
    expect(runs.runResume).not.toHaveBeenCalled();
    expect(newCommand.runNew).not.toHaveBeenCalled();
  });
});
