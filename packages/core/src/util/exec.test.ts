import { describe, expect, it } from "vitest";
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
});
