import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveModel } from "@factory/shared";
import { git, tempDir } from "../../test/helpers.js";
import { ConfigError, parseConfig } from "./load.js";
import { resetConfig, resetConfigText } from "./reset.js";

const CONFIG = `# Software factory configuration. Commit this file.
version: 1

checks:
  - name: "test"
    run: "pnpm test"

gates:
  triage: auto
  merge: human

# Model and effort per agent.
models:
  default: "opus"
  roles:
    triage: "fable"                               # a pinned old default
    builder: { model: "opus", effort: "high" }
  reviews:
    docs: { model: "haiku", effort: "low" }

trust:
  authors: ["alice"]
`;

const defaults = parseConfig("version: 1\n");

describe("resetConfigText", () => {
  it("takes a section and its comment out, so its defaults apply, and leaves the rest byte for byte", () => {
    const { text, removed, notSet } = resetConfigText(CONFIG, { paths: ["models"] });
    expect(removed).toEqual(["models"]);
    expect(notSet).toEqual([]);
    expect(text).toBe(CONFIG.replace(/# Model and effort per agent\.\n[\s\S]*?\n\n/, ""));
    expect(parseConfig(text).models).toEqual(defaults.models);
    expect(parseConfig(text).trust.authors).toEqual(["alice"]);
  });

  it("keeps Windows line endings", () => {
    const crlf = CONFIG.replace(/\n/g, "\r\n");
    const { text } = resetConfigText(crlf, { paths: ["gates"] });
    expect(text).toBe(CONFIG.replace("gates:\n  triage: auto\n  merge: human\n\n", "").replace(/\n/g, "\r\n"));
  });

  it("resets a single entry, and takes its group along when it was the only one there", () => {
    const one = resetConfigText(CONFIG, { paths: ["models.roles.triage"] });
    expect(one.removed).toEqual(["models.roles.triage"]);
    expect(one.text).not.toContain("fable");
    expect(one.text).toContain('    builder: { model: "opus", effort: "high" }');
    expect(resolveModel(parseConfig(one.text), { role: "triage" })).toEqual(resolveModel(defaults, { role: "triage" }));

    const group = resetConfigText(CONFIG, { paths: ["models.reviews.docs"] });
    expect(group.text).not.toContain("reviews:");
    expect(parseConfig(group.text).models.reviews).toEqual(defaults.models.reviews);
  });

  it("takes a section along when the named entries together leave nothing in it", () => {
    const config = "version: 1\nmodels:\n  default: sonnet\n  effort: low\nloops:\n  max_build_iterations: 3\n";
    const { text, removed } = resetConfigText(config, { paths: ["models.default", "models.effort"] });
    expect(removed).toEqual(["models.default", "models.effort"]);
    expect(text).toBe("version: 1\nloops:\n  max_build_iterations: 3\n");
  });

  it("refuses a path into a list, which has no named entries", () => {
    expect(() => resetConfigText(CONFIG, { paths: ["checks.0"] })).toThrow(/checks is not a group of named settings/);
  });

  it("resets everything but what only the project knows with all", () => {
    const { text, removed } = resetConfigText(CONFIG, { all: true });
    expect(removed).toEqual(["gates", "models"]);
    const config = parseConfig(text);
    expect(config.checks).toEqual([{ name: "test", run: "pnpm test", timeout_sec: 900, retries: 1 }]);
    expect(config.trust.authors).toEqual(["alice"]);
    expect(config.gates).toEqual(defaults.gates);
    expect(text.startsWith("# Software factory configuration. Commit this file.\nversion: 1\n")).toBe(true);
  });

  it("says which settings were not in the file, and changes nothing for them", () => {
    const { text, removed, notSet } = resetConfigText(CONFIG, { paths: ["loops", "models.roles.critic"] });
    expect(removed).toEqual([]);
    expect(notSet).toEqual(["loops", "models.roles.critic"]);
    expect(text).toBe(CONFIG);
  });

  it("refuses names that are not settings, and the schema version", () => {
    expect(() => resetConfigText(CONFIG, { paths: ["modles"] })).toThrow(/modles: not a setting that can be reset/);
    expect(() => resetConfigText(CONFIG, { paths: ["version"] })).toThrow(ConfigError);
    expect(() => resetConfigText(CONFIG, { paths: ["models..roles"] })).toThrow(ConfigError);
  });

  it("refuses to cut into a section written inline, where its lines hold other settings too", () => {
    const inline = "version: 1\nmodels: { roles: { triage: fable }, default: opus }\n";
    expect(() => resetConfigText(inline, { paths: ["models.roles"] })).toThrow(/written inline/);
    // The whole section is one entry of the top level, which is not inline, so that works.
    expect(resetConfigText(inline, { paths: ["models"] }).text).toBe("version: 1\n");
  });
});

describe("resetConfig", () => {
  it("rewrites the repo's config file, and only when something was removed", () => {
    const dir = tempDir();
    git(dir, "init", "-q");
    mkdirSync(join(dir, ".factory"));
    const file = join(dir, ".factory", "config.yaml");
    writeFileSync(file, CONFIG);

    expect(resetConfig({ cwd: dir, target: { paths: ["loops"] } }).removed).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(CONFIG);
    const result = resetConfig({ cwd: dir, target: { paths: ["models"] } });
    expect(result.removed).toEqual(["models"]);
    // git names the repo by its long path; the temp dir can be an 8.3 short name (RUNNER~1 on CI).
    expect(realpathSync.native(result.path)).toBe(realpathSync.native(file));
    expect(readFileSync(file, "utf8")).not.toContain("models:");
  });

  it("asks for factory init when there is no config", () => {
    const dir = tempDir();
    git(dir, "init", "-q");
    expect(() => resetConfig({ cwd: dir, target: { all: true } })).toThrow(/run `factory init` first/);
  });
});
