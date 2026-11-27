import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../util/exec.js";
import { commitToRemote } from "./commit-remote.js";

describe("commitToRemote", () => {
  it("preserves the commit failure as the cause when a hook refuses", () => {
    const run: CommandRunner = (_cmd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "base-commit", stderr: "" };
      if (args[0] === "commit") return { code: 1, stdout: "", stderr: "hook failed" };
      return { code: 0, stdout: "", stderr: "" };
    };

    let thrown: unknown;
    try {
      commitToRemote({
        root: process.cwd(),
        run,
        base: "main",
        branch: "main",
        write: () => ["file.txt"],
        message: "chore: test",
        what: "the test commit",
        tempPrefix: "factory-test-",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).cause).toMatchObject({ message: "git commit failed: hook failed" });
  });
});
