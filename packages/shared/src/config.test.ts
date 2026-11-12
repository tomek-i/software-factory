import { describe, expect, it } from "vitest";
import { factoryConfigSchema, isTrustedAuthor, isTrustedIssue, resolveModel } from "./config.js";

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

describe("isTrustedIssue", () => {
  const config = factoryConfigSchema.parse({ version: 1, trust: { authors: ["alice"] } });

  it("trusts an issue the factory created, whoever its GitHub author is", () => {
    expect(isTrustedIssue(config, { author: "factory-bot", created_by_factory: true })).toBe(true);
  });

  it("otherwise goes by the author", () => {
    expect(isTrustedIssue(config, { author: "alice", created_by_factory: false })).toBe(true);
    expect(isTrustedIssue(config, { author: "mallory", created_by_factory: false })).toBe(false);
    expect(isTrustedIssue(config, { author: "mallory" })).toBe(false);
  });
});

describe("factoryConfigSchema", () => {
  it("wants {port} in app.url, and passes no extra env to the app by default", () => {
    const app = factoryConfigSchema.parse({ version: 1 }).app;
    expect(app).toMatchObject({ url: "http://localhost:{port}", port_env: "PORT", ready_timeout_sec: 180, env: [] });
    expect(factoryConfigSchema.safeParse({ version: 1, app: { url: "http://localhost:3000" } }).success).toBe(false);
    expect(factoryConfigSchema.parse({ version: 1, app: { url: "http://127.0.0.1:{port}/app", env: ["DATABASE_URL"] } }).app.env).toEqual(["DATABASE_URL"]);
  });

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

  it("rejects protected-path globs that would silently match nothing", () => {
    for (const glob of ["{a,b}/**", "src/[ab].ts", "/infra/**", "./infra/**", "infra\\**"]) {
      expect(() => factoryConfigSchema.parse({ version: 1, hard_rules: { paths: [glob] } }), glob).toThrow(/repo-relative glob/);
    }
  });

  it("has no way to enable unsafe mode from config", () => {
    const config = factoryConfigSchema.parse({ version: 1, unsafe: true } as unknown);
    expect("unsafe" in config).toBe(false);
  });
});

describe("resolveModel", () => {
  const config = factoryConfigSchema.parse({
    version: 1,
    models: {
      default: "opus",
      effort: "high",
      roles: { triage: "fable", reviewer: { model: "sonnet", effort: "medium" }, verifier: { effort: "low" } },
      reviews: { docs: { model: "haiku", effort: "low" }, security: "opus" },
      high_risk: { code: { model: "opus" }, builder: { effort: "xhigh" } },
    },
  });

  it("accepts a plain alias or a model/effort object and rejects unknown effort", () => {
    expect(config.models.roles.triage).toEqual({ model: "fable" });
    expect(config.models.roles.reviewer).toEqual({ model: "sonnet", effort: "medium" });
    expect(
      factoryConfigSchema.safeParse({ version: 1, models: { roles: { builder: { effort: "turbo" } } } }).success,
    ).toBe(false);
    expect(
      factoryConfigSchema.safeParse({ version: 1, models: { roles: { builder: { modle: "opus" } } } }).success,
    ).toBe(false);
  });

  it("falls back from role to the defaults", () => {
    expect(resolveModel(config, { role: "triage" })).toEqual({ model: "fable", effort: "high" });
    expect(resolveModel(config, { role: "builder" })).toEqual({ model: "opus", effort: "high" });
  });

  it("resolves model and effort separately", () => {
    expect(resolveModel(config, { role: "verifier" })).toEqual({ model: "opus", effort: "low" });
    expect(resolveModel(config, { role: "reviewer", lens: "security" })).toEqual({ model: "opus", effort: "medium" });
  });

  it("uses the lens entry, then the reviewer role", () => {
    expect(resolveModel(config, { role: "reviewer", lens: "docs" })).toEqual({ model: "haiku", effort: "low" });
    expect(resolveModel(config, { role: "reviewer", lens: "code" })).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("applies high_risk only when triage said HIGH", () => {
    expect(resolveModel(config, { role: "reviewer", lens: "code", risk: "MEDIUM" }).model).toBe("sonnet");
    expect(resolveModel(config, { role: "reviewer", lens: "code", risk: "HIGH" })).toEqual({ model: "opus", effort: "medium" });
    expect(resolveModel(config, { role: "builder", risk: "HIGH" })).toEqual({ model: "opus", effort: "xhigh" });
  });

  it("leaves effort unset when nothing configures it", () => {
    expect(resolveModel(factoryConfigSchema.parse({ version: 1 }), { role: "builder" })).toEqual({ model: "opus" });
  });
});

describe("merge config", () => {
  it("merges with a merge commit and waits 30 minutes for required checks by default", () => {
    expect(factoryConfigSchema.parse({ version: 1 }).merge).toEqual({ method: "merge", checks_timeout_min: 30 });
    expect(factoryConfigSchema.parse({ version: 1, merge: { method: "squash" } }).merge.method).toBe("squash");
  });

  it("refuses an unknown method and a timeout that is not positive", () => {
    expect(factoryConfigSchema.safeParse({ version: 1, merge: { method: "fast-forward" } }).success).toBe(false);
    expect(factoryConfigSchema.safeParse({ version: 1, merge: { checks_timeout_min: 0 } }).success).toBe(false);
  });
});
