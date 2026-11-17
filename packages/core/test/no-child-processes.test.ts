import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/util/exec.js";
import { blockedCalls } from "./no-child-processes.js";

// A unit test that starts a process (git, the fake `claude`, Chromium) is a misfiled integration
// test: the unit project's setup must stop it, or the fast loop slowly turns into the slow one.
describe("the unit project's child process guard", () => {
  // These tests start processes on purpose; the guard would otherwise fail this file afterwards.
  afterEach(() => {
    blockedCalls.length = 0;
  });

  it("stops a process started through a named import", () => {
    expect(() => execFileSync("git", ["--version"])).toThrow(/name the file \*\.int\.test\.ts/);
    expect(() => spawn("node", ["-v"])).toThrow(/name the file \*\.int\.test\.ts/);
    expect(blockedCalls).toEqual(['execFileSync("git")', 'spawn("node")']);
  });

  it("records a process even when the error is swallowed, so the file still fails", () => {
    try {
      runCommand("git", ["--version"], { cwd: process.cwd() });
    } catch {
      // What code under test might do; the setup's afterAll catches it.
    }
    expect(blockedCalls).toEqual(['spawnSync("git")']);
  });
});
