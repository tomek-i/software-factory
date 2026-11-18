import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { factoryConfigSchema } from "./config.js";
import { defaultConfig, SETTINGS, valueAt } from "./settings.js";

/** The dotted paths of the schema's settings: its nested objects are walked, anything else is one setting. */
function schemaLeaves(schema: z.ZodType, prefix = ""): string[] {
  let node = schema;
  // default, prefault, optional and the like wrap the type that says what the setting is.
  while ("innerType" in node.def) node = node.def.innerType as z.ZodType;
  if (node.def.type !== "object") return [prefix];
  const shape = (node as unknown as z.ZodObject).shape;
  return Object.entries(shape).flatMap(([key, child]) => schemaLeaves(child as z.ZodType, prefix ? `${prefix}.${key}` : key));
}

describe("SETTINGS", () => {
  it("has exactly one entry per setting of the config schema, so a new setting can't be left off the page", () => {
    const leaves = schemaLeaves(factoryConfigSchema).filter((p) => p !== "version");
    expect([...SETTINGS.map((s) => s.path)].sort()).toEqual([...leaves].sort());
  });

  it("offers only options the schema accepts", () => {
    for (const setting of SETTINGS) {
      if (setting.kind.type !== "enum") continue;
      for (const option of setting.kind.options) {
        const [section, key] = setting.path.split(".");
        expect(factoryConfigSchema.safeParse({ version: 1, [section!]: { [key!]: option } }).success, `${setting.path}: ${option}`).toBe(true);
      }
    }
  });

  it("reads defaults and values by path", () => {
    expect(valueAt(defaultConfig(), "gates.merge")).toBe("human");
    expect(valueAt(defaultConfig(), "models.default")).toBeUndefined();
    expect(valueAt({ a: [1] }, "a.0")).toBeUndefined();
  });
});
