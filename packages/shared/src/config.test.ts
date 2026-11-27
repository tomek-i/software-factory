import { describe, expect, it } from "vitest";
import { factoryConfigSchema, isTrustedAuthor, isTrustedIssue, resolveModel, securityScanModel } from "./config.js";

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

describe("securityScanModel", () => {
  it("uses only the scan's own entries, so a cheaper default for the agent lenses never reaches it", () => {
    const cheap = factoryConfigSchema.parse({ version: 1, models: { default: "haiku", roles: { reviewer: "haiku" }, high_risk: { reviewer: "haiku" } } });
    expect(securityScanModel(cheap)).toBe("opus");
    expect(securityScanModel(cheap, "HIGH")).toBe("opus");
    const own = factoryConfigSchema.parse({ version: 1, models: { reviews: { "security-scan": "sonnet" }, high_risk: { "security-scan": "fable" } } });
    expect(securityScanModel(own, "MEDIUM")).toBe("sonnet");
    expect(securityScanModel(own, "HIGH")).toBe("fable");
  });

  it("keeps the deep scan out of the lenses you pick in reviews", () => {
    expect(factoryConfigSchema.safeParse({ version: 1, reviews: { always: ["security-scan"] } }).success).toBe(false);
    expect(factoryConfigSchema.parse({ version: 1 }).security).toEqual({ scan_tool: "auto", scan_when: "off", scan_effort: "low", scan_timeout_min: 60, audit_effort: "medium", audit_timeout_min: 240 });
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

  it("uses the recommended models when the config sets none", () => {
    const defaults = factoryConfigSchema.parse({ version: 1 });
    expect(resolveModel(defaults, { role: "triage" })).toEqual({ model: "opus", effort: "high" });
    expect(resolveModel(defaults, { role: "builder" })).toEqual({ model: "opus", effort: "medium" });
    expect(resolveModel(defaults, { role: "builder", risk: "HIGH" })).toEqual({ model: "opus", effort: "high" });
    expect(resolveModel(defaults, { role: "reviewer", lens: "docs" })).toEqual({ model: "haiku", effort: "low" });
    expect(resolveModel(defaults, { role: "capture" })).toEqual({ model: "haiku", effort: "low" });
  });

  it("fills in only what the config leaves open, so a better default still reaches the rest", () => {
    const custom = factoryConfigSchema.parse({ version: 1, models: { roles: { builder: "sonnet" }, reviews: { docs: "sonnet" } } });
    expect(resolveModel(custom, { role: "builder" })).toEqual({ model: "sonnet", effort: "medium" });
    expect(resolveModel(custom, { role: "reviewer", lens: "docs" })).toEqual({ model: "sonnet", effort: "low" });
    expect(resolveModel(custom, { role: "triage" })).toEqual({ model: "opus", effort: "high" });
    expect(resolveModel(custom, { role: "reviewer", lens: "ui" })).toEqual({ model: "haiku", effort: "low" });
  });

  it("lets anything the config sets beat every recommendation", () => {
    // default and effort reach every agent the config does not name, recommended entries or not.
    const everywhere = factoryConfigSchema.parse({ version: 1, models: { default: "sonnet", effort: "low" } });
    expect(resolveModel(everywhere, { role: "triage" })).toEqual({ model: "sonnet", effort: "low" });
    expect(resolveModel(everywhere, { role: "builder", risk: "HIGH" })).toEqual({ model: "sonnet", effort: "low" });
    expect(resolveModel(everywhere, { role: "reviewer", lens: "security" })).toEqual({ model: "sonnet", effort: "low" });
    // roles.reviewer reaches the lenses, although every lens has a recommended entry.
    const reviewer = factoryConfigSchema.parse({ version: 1, models: { roles: { reviewer: "haiku" } } });
    expect(resolveModel(reviewer, { role: "reviewer", lens: "code" }).model).toBe("haiku");
    // A role's own choice holds for high-risk issues too, without repeating it under high_risk.
    const builder = factoryConfigSchema.parse({ version: 1, models: { roles: { builder: "sonnet" } } });
    expect(resolveModel(builder, { role: "builder", risk: "HIGH" })).toEqual({ model: "sonnet", effort: "high" });
  });
});

describe("merge config", () => {
  it("merges with a merge commit, waits 30 minutes for required checks, asks about open feedback and opens unqueued follow-ups by default", () => {
    expect(factoryConfigSchema.parse({ version: 1 }).merge).toEqual({
      method: "merge",
      checks_timeout_min: 30,
      open_feedback: "ask",
      comment_bots: ["github-advanced-security[bot]"],
      followup_issues: true,
      queue_followups: false,
    });
    expect(factoryConfigSchema.parse({ version: 1, merge: { method: "squash" } }).merge.method).toBe("squash");
  });

  it("refuses an unknown method and a timeout that is not positive", () => {
    expect(factoryConfigSchema.safeParse({ version: 1, merge: { method: "fast-forward" } }).success).toBe(false);
    expect(factoryConfigSchema.safeParse({ version: 1, merge: { checks_timeout_min: 0 } }).success).toBe(false);
  });

  it("takes ask, fix or ignore for open feedback, and a list of bots", () => {
    for (const mode of ["ask", "fix", "ignore"]) expect(factoryConfigSchema.parse({ version: 1, merge: { open_feedback: mode } }).merge.open_feedback).toBe(mode);
    // `always`/`never` are gate modes, not these.
    expect(factoryConfigSchema.safeParse({ version: 1, merge: { open_feedback: "always" } }).success).toBe(false);
    expect(factoryConfigSchema.parse({ version: 1, merge: { comment_bots: [] } }).merge.comment_bots).toEqual([]);
    expect(factoryConfigSchema.safeParse({ version: 1, merge: { comment_bots: [""] } }).success).toBe(false);
  });
});

describe("project.default_branch", () => {
  const parse = (name: string) => factoryConfigSchema.safeParse({ version: 1, project: { default_branch: name } });

  it("takes ordinary branch names", () => {
    for (const name of ["main", "master", "develop", "release/2.x", "feature_x-1"]) expect(parse(name).success).toBe(true);
  });

  it("refuses names git would read as an option or refuse as a branch", () => {
    for (const name of ["--upload-pack=calc", "-x", "a..b", "has space", "a:b", "a~1", "a^", "ends/", "ends.", "a\b", ""]) {
      expect(parse(name).success).toBe(false);
    }
  });
});
