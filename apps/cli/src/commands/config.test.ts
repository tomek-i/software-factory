import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "@factory/core";
import { CliError } from "../context.js";
import { runConfigReset } from "./config.js";

function repoWithConfig(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-cli-"));
  runCommand("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".factory"));
  writeFileSync(join(dir, ".factory", "config.yaml"), config);
  return dir;
}

const CONFIG = 'version: 1\nproject:\n  default_branch: "trunk"\nmodels:\n  roles:\n    triage: "fable"\n';

describe("runConfigReset", () => {
  it("says what it reset and that the change only counts once it is merged", () => {
    const dir = repoWithConfig(CONFIG);
    const output = runConfigReset(dir, ["models", "loops"], {});
    expect(output).toBe(
      [
        "Reset models in .factory/config.yaml: the defaults apply now.",
        "- loops is not set in the file, so it already uses the default",
        "Commit the change and merge it into trunk: runs read the config from origin/trunk.",
      ].join("\n"),
    );
    expect(readFileSync(join(dir, ".factory", "config.yaml"), "utf8")).toBe('version: 1\nproject:\n  default_branch: "trunk"\n');
  });

  it("says when there was nothing to reset", () => {
    const dir = repoWithConfig("version: 1\n");
    expect(runConfigReset(dir, [], { all: true })).toBe("Nothing to reset: .factory/config.yaml is unchanged.");
  });

  it("needs settings or --all, but not both", () => {
    const dir = repoWithConfig(CONFIG);
    expect(() => runConfigReset(dir, [], {})).toThrow(CliError);
    expect(() => runConfigReset(dir, ["models"], { all: true })).toThrow(CliError);
    expect(readFileSync(join(dir, ".factory", "config.yaml"), "utf8")).toBe(CONFIG);
  });
});
