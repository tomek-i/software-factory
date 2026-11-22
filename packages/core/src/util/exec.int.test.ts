import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { runCommand } from "./exec.js";

describe("runCommand", () => {
  it("kills a tool that runs past its timeout and says so", () => {
    const started = Date.now();
    const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: process.cwd(), timeoutMs: 500 });
    expect(result).toMatchObject({ code: -1, stderr: expect.stringMatching(/timed out after 0\.5s$/) });
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("returns the exit code and trimmed output", () => {
    expect(runCommand(process.execPath, ["-e", "console.log(' hi '); process.exit(3)"], { cwd: process.cwd() })).toEqual({ code: 3, stdout: "hi", stderr: "" });
  });

  it("with inherit, leaves the output to the terminal and returns only the exit code", () => {
    expect(runCommand(process.execPath, ["-e", "process.exit(4)"], { cwd: process.cwd(), inherit: true })).toEqual({ code: 4, stdout: "", stderr: "" });
  });

  // Windows runs .cmd scripts (npm, pnpm, yarn) only through cmd; Node refuses to start one directly.
  it.runIf(process.platform === "win32")("with windowsScript, starts a .cmd script through cmd", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "greet.cmd"), "@echo off\r\necho hello %1\r\n");
    expect(runCommand(join(dir, "greet.cmd"), ["there"], { cwd: dir, windowsScript: true })).toEqual({ code: 0, stdout: "hello there", stderr: "" });
    expect(runCommand(join(dir, "greet.cmd"), ["there"], { cwd: dir }).code).not.toBe(0);
  });
});
