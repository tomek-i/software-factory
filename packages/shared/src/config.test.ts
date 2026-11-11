import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "./config.js";

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

  it("has no way to enable unsafe mode from config", () => {
    const config = factoryConfigSchema.parse({ version: 1, unsafe: true } as unknown);
    expect("unsafe" in config).toBe(false);
  });
});
