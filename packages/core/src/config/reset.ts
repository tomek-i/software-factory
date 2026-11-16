import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMap, isScalar, parseDocument, type Pair, type YAMLMap } from "yaml";
import { factoryConfigSchema } from "@factory/shared";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { findRepoRoot } from "../util/git.js";
import { configPath, ConfigError, CONFIG_FILE, FACTORY_DIR, parseConfig } from "./load.js";

/** What only the project can know. `--all` keeps them: their defaults (no checks, nobody trusted) would break it. */
export const PROJECT_SECTIONS = ["project", "checks", "app", "trust"] as const;

/** Top-level keys a reset can name. `version` is not one: it says which schema the file follows. */
export const RESETTABLE_SECTIONS = Object.keys(factoryConfigSchema.shape).filter((k) => k !== "version");

export type ResetTarget = { paths: string[] } | { all: true };

export interface ResetResult {
  text: string;
  /** Dotted paths taken out of the file, so their defaults apply. */
  removed: string[];
  /** Dotted paths that were asked for but are not in the file (they already use the defaults). */
  notSet: string[];
}

/**
 * Take settings out of config text so the schema defaults apply to them. Only the lines of the removed
 * entries (and the comment lines directly above them) go; everything else stays byte for byte, so
 * comments, formatting and line endings survive. An entry whose parent would be left empty takes the
 * parent with it, since an empty block would parse as null.
 */
export function resetConfigText(text: string, target: ResetTarget, path: string = CONFIG_FILE): ResetResult {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError(path, doc.errors.map((e) => `YAML syntax: ${e.message}`));
  const root = doc.contents;
  if (!isMap(root)) throw new ConfigError(path, ["(root): expected a mapping of settings"]);

  const all = "all" in target;
  const paths = all
    ? RESETTABLE_SECTIONS.filter((s) => !(PROJECT_SECTIONS as readonly string[]).includes(s)).map((s) => [s])
    : target.paths.map((p) => p.split("."));
  const unknown = paths.filter((p) => !RESETTABLE_SECTIONS.includes(p[0]!) || p.some((segment) => segment === ""));
  if (unknown.length) {
    throw new ConfigError(path, unknown.map((p) => `${p.join(".")}: not a setting that can be reset (sections: ${RESETTABLE_SECTIONS.join(", ")})`));
  }

  const removed: string[] = [];
  const notSet: string[] = [];
  const cuts: [number, number][] = [];
  for (const segments of paths) {
    const found = findPair(root, segments, path);
    if (!found) {
      if (!all) notSet.push(segments.join("."));
      continue;
    }
    removed.push(segments.join("."));
    cuts.push(lineSpan(text, found));
  }
  if (!cuts.length) return { text, removed, notSet };

  // Cut from the end so earlier offsets stay valid; overlapping cuts (a section and one of its entries) merge.
  const merged = cuts.sort((a, b) => a[0] - b[0]).reduce<[number, number][]>((acc, cut) => {
    const last = acc.at(-1);
    if (last && cut[0] <= last[1]) last[1] = Math.max(last[1], cut[1]);
    else acc.push([...cut]);
    return acc;
  }, []);
  let out = text;
  for (const [start, end] of merged.reverse()) out = out.slice(0, start) + out.slice(end);
  // A broken result is never written: this throws a ConfigError naming the problem.
  parseConfig(out, path);
  return { text: out, removed, notSet };
}

/**
 * The pair to remove for a path: the entry itself, or the nearest ancestor that would be left
 * empty without it. Undefined when the path is not in the file.
 */
function findPair(root: YAMLMap, segments: string[], path: string): Pair | undefined {
  const chain: { map: YAMLMap; pair: Pair }[] = [];
  let map: unknown = root;
  for (const segment of segments) {
    if (!isMap(map)) return undefined;
    // Cutting lines out of a {...} written on one line would cut its neighbours too.
    if (map.flow) throw new ConfigError(path, [`${segments.join(".")}: written inline ({ ... }); remove it by hand`]);
    const pair = map.items.find((p) => isScalar(p.key) && String(p.key.value) === segment);
    if (!pair) return undefined;
    chain.push({ map, pair });
    map = pair.value;
  }
  let index = chain.length - 1;
  while (index > 0 && chain[index]!.map.items.length === 1) index--;
  return chain[index]!.pair;
}

/** The pair's whole lines, from the comment lines directly above it to the end of its last line. */
function lineSpan(text: string, pair: Pair): [number, number] {
  const key = pair.key as { range: [number, number, number] };
  const value = pair.value as { range?: [number, number, number] } | null;
  let start = text.lastIndexOf("\n", key.range[0] - 1) + 1;
  while (start > 0) {
    const above = text.lastIndexOf("\n", start - 2) + 1;
    if (!/^\s*#/.test(text.slice(above, start))) break;
    start = above;
  }
  const last = value?.range ? Math.max(value.range[1], key.range[2]) : key.range[2];
  const newline = text.indexOf("\n", Math.max(last - 1, key.range[0]));
  let end = newline === -1 ? text.length : newline + 1;
  // A section between two blank lines takes one of them, so no double gap is left behind.
  const blank = /^\r?\n/.exec(text.slice(end));
  if (blank && /(^|\n)\r?\n$/.test(text.slice(0, start))) end += blank[0].length;
  return [start, end];
}

/** Reset settings in the working copy's `.factory/config.yaml` of the repo containing `cwd`. */
export function resetConfig(options: { cwd: string; target: ResetTarget; run?: CommandRunner }): ResetResult & { path: string } {
  const root = findRepoRoot(options.cwd, options.run ?? runCommand);
  const path = root ? configPath(root) : `${FACTORY_DIR}/${CONFIG_FILE}`;
  if (!root || !existsSync(path)) throw new ConfigError(path, ["file not found - run `factory init` first"]);
  const result = resetConfigText(readFileSync(path, "utf8"), options.target, path);
  if (result.removed.length) writeFileSync(path, result.text);
  return { ...result, path };
}
