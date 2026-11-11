import { describe, expect, it } from "vitest";
import { factoryConfigSchema, isTrustedAuthor } from "./config.js";

describe("isTrustedAuthor", () => {
  it("trusts nobody by default", () => {
    expect(isTrustedAuthor(factoryConfigSchema.parse({ version: 1 }), "alice")).toBe(false);
  });

  it("matches listed handles case-insensitively, with or without @", () => {
    const config = factoryConfigSchema.parse({ version: 1, trust: { authors: ["Alice", "@bob"] } });
    expect(isTrustedAuthor(config, "alice")).toBe(true);
    expect(isTrustedAuthor(config, "BOB")).toBe(true);
    expect(isTrustedAuthor(config, "mallory")).toBe(false);
  });

  it("trusts everyone when the repo is configured that way", () => {
    expect(isTrustedAuthor(factoryConfigSchema.parse({ version: 1, trust: { everyone: true } }), "anyone")).toBe(true);
  });
});

describe("factoryConfigSchema", () => {
  it("fills safe defaults from a minimal config", () => {
    const config = factoryConfigSchema.parse({ version: 1 });

    expect(config.gates.issue_writer).toBe("human");
    expect(config.gates.merge).toBe("human");
    expect(config.loops.max_build_iterations).toBe(5);
    expect(config.hard_rules.paths).toContain(".github/workflows/**");
    expect(config.reviews.always).toEqual(["code", "security", "docs"]);
  });

  it("rejects an unknown gate mode", () => {
    expect(factoryConfigSchema.safeParse({ version: 1, gates: { merge: "yolo" } }).success).toBe(false);
  });

  it("cannot switch hard rules off, only add to them", () => {
    const config = factoryConfigSchema.parse({
      version: 1,
      hard_rules: { paths: ["billing/**"], triggers: [] },
    });
    expect(config.hard_rules.paths).toEqual(expect.arrayContaining([".github/workflows/**", ".factory/**", "billing/**"]));
    expect(config.hard_rules.triggers).toEqual(["new_dependency", "secrets_or_env_changes", "deletes_files_outside_scope"]);
  });

  it("has no way to enable unsafe mode from config", () => {
    const config = factoryConfigSchema.parse({ version: 1, unsafe: true } as unknown);
    expect("unsafe" in config).toBe(false);
  });
});
