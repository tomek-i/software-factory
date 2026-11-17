import { describe, expect, it } from "vitest";
import { ConfigError } from "./load.js";
import { setConfigValue } from "./set.js";

const config = [
  "# top comment",
  "version: 1",
  "project:",
  '  name: "shop"   # the name',
  "github:",
  "  status_labels: false",
  "",
].join("\n");

describe("setConfigValue", () => {
  it("replaces only the value, keeping comments and formatting", () => {
    const { text, changed } = setConfigValue(config, "project.name", "store");

    expect(changed).toBe(true);
    expect(text).toBe(config.replace('"shop"', '"store"'));
  });

  it("sets a boolean", () => {
    expect(setConfigValue(config, "github.status_labels", true).text).toContain("  status_labels: true\n");
  });

  it("keeps CRLF line endings", () => {
    const crlf = config.replace(/\n/g, "\r\n");

    expect(setConfigValue(crlf, "project.name", "store").text).toBe(crlf.replace('"shop"', '"store"'));
  });

  it("reports no change when the value is already set", () => {
    expect(setConfigValue(config, "project.name", "shop")).toEqual({ text: config, changed: false });
  });

  it("refuses a setting that is not in the file", () => {
    expect(() => setConfigValue("version: 1\n", "github.status_labels", true)).toThrow(ConfigError);
  });

  it("refuses a setting whose parent is a plain value, rather than overwriting the parent", () => {
    expect(() => setConfigValue('version: 1\nproject: "shop"\n', "project.name", "store")).toThrow(/not in the file/);
  });

  it.each([
    ["a multi-line value", 'version: 1\nproject:\n  name: >-\n    shop\n  default_branch: "main"\n'],
    ["an empty value", "version: 1\nproject:\n  name:\n"],
    ["an anchored value", "version: 1\nproject:\n  name: &n shop\n"],
  ])("refuses %s rather than producing a broken file", (_, text) => {
    expect(() => setConfigValue(text, "project.name", "store")).toThrow(/set it by hand/);
  });

  it("refuses an alias", () => {
    expect(() => setConfigValue("version: 1\nx: &n shop\nproject:\n  name: *n\n", "project.name", "store")).toThrow(/alias/);
  });

  it("refuses an inline mapping", () => {
    expect(() => setConfigValue("version: 1\ngithub: { status_labels: false }\n", "github.status_labels", true)).toThrow(/by hand/);
  });

  it("refuses a value the schema rejects", () => {
    const withBranch = config.replace("project:\n", 'project:\n  default_branch: "main"\n');

    expect(() => setConfigValue(withBranch, "project.default_branch", "--upload-pack=x")).toThrow(ConfigError);
  });
});
