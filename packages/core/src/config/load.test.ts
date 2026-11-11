import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "./load.js";

describe("parseConfig", () => {
  it("parses yaml and applies defaults", () => {
    const config = parseConfig("version: 1\nchecks:\n  - name: test\n    run: pnpm test\n");
    expect(config.checks).toEqual([{ name: "test", run: "pnpm test", timeout_sec: 900 }]);
    expect(config.gates.triage).toBe("auto");
  });

  it("reports schema problems with their paths", () => {
    expect(() => parseConfig("version: 1\ngates:\n  merge: sometimes\n")).toThrow(/gates\.merge/);
  });

  it("reports yaml syntax errors", () => {
    expect(() => parseConfig("version: [1")).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  it("tells the user to run init when the file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-cfg-"));
    expect(() => loadConfig(dir)).toThrow(/factory init/);
  });

  it("loads .factory/config.yaml from the repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-cfg-"));
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "config.yaml"), "version: 1\nproject:\n  name: demo\n");
    expect(loadConfig(dir).project.name).toBe("demo");
  });
});
