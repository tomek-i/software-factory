import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A file inside a Claude Code plugin installed from any marketplace, in the newest version Claude
 * Code's plugin cache holds (`~/.claude/plugins/cache/<marketplace>/<plugin>/<x.y.z>/<file>`).
 * Undefined when no version has it.
 */
export function newestPluginFile(home: string, plugin: string, file: string[]): string | undefined {
  const cache = join(home, ".claude", "plugins", "cache");
  const found: { version: number[]; path: string }[] = [];
  for (const marketplace of list(cache)) {
    const dir = join(cache, marketplace, plugin);
    for (const version of list(dir)) {
      const path = join(dir, version, ...file);
      const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      if (parsed && existsSync(path)) found.push({ version: parsed.slice(1).map(Number), path });
    }
  }
  found.sort((a, b) => compare(b.version, a.version));
  return found[0]?.path;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
