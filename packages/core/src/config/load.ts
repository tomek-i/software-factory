import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { factoryConfigSchema, type FactoryConfig } from "@factory/shared";

export const FACTORY_DIR = ".factory";
export const CONFIG_FILE = "config.yaml";

export function configPath(repoRoot: string): string {
  return join(repoRoot, FACTORY_DIR, CONFIG_FILE);
}

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    readonly problems: string[],
  ) {
    super(`Invalid factory config at ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Parse config text; exported separately so it can be tested without touching disk. */
export function parseConfig(text: string, path = CONFIG_FILE): FactoryConfig {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    throw new ConfigError(path, [`YAML syntax: ${(err as Error).message}`]);
  }
  const result = factoryConfigSchema.safeParse(data ?? {});
  if (!result.success) {
    throw new ConfigError(
      path,
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}

export function loadConfig(repoRoot: string): FactoryConfig {
  const path = configPath(repoRoot);
  if (!existsSync(path)) {
    throw new ConfigError(path, ["file not found - run `factory init` first"]);
  }
  return parseConfig(readFileSync(path, "utf8"), path);
}
