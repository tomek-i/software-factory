import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "@factory/core";
import { runInit } from "./init.js";

describe("runInit", () => {
  it("prints each step and the next action", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-cli-"));
    runCommand("git", ["init", "-q"], { cwd: dir });

    const output = runInit(dir, { labels: false });

    expect(output).toMatch(/^Initialised software factory in /);
    expect(output).toContain("+ Wrote .factory/config.yaml");
    expect(output).toContain("- GitHub labels (--no-labels)");
    expect(output).toContain("Next: review .factory/config.yaml");
  });
});
