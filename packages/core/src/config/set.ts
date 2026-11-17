import { isAlias, isMap, isScalar, parseDocument, Scalar } from "yaml";
import { ConfigError, CONFIG_FILE, parseConfig } from "./load.js";

export interface SetResult {
  text: string;
  /** False when the file already held the value, so the text is unchanged. */
  changed: boolean;
}

/**
 * Set one setting that is already in the config text. Only the value's characters change, so
 * comments, formatting and line endings survive. A setting missing from the file is an error
 * rather than an addition: inserting it would mean choosing where and how to write it.
 */
export function setConfigValue(text: string, dotted: string, value: string | boolean, path: string = CONFIG_FILE): SetResult {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new ConfigError(path, doc.errors.map((e) => `YAML syntax: ${e.message}`));
  const segments = dotted.split(".");
  let node: unknown = doc.contents;
  for (const segment of segments) {
    if (!isMap(node)) {
      node = undefined;
      break;
    }
    // Editing inside a {...} written on one line is left to a human.
    if (node.flow) throw new ConfigError(path, [`${dotted}: written inline ({ ... }); set it by hand`]);
    node = node.items.find((p) => isScalar(p.key) && String(p.key.value) === segment)?.value;
  }
  if (isAlias(node)) throw new ConfigError(path, [`${dotted}: points to another value (*alias); set it by hand`]);
  if (!isScalar(node) || !node.range) throw new ConfigError(path, [`${dotted}: not in the file; add it by hand`]);
  if (node.value === value) return { text, changed: false };
  // Only a value written on its own line can be swapped in place: a block scalar's range runs on into
  // the next line, an empty one has no characters to replace, and an anchored one is shared.
  const inline = node.type === Scalar.PLAIN || node.type === Scalar.QUOTE_DOUBLE || node.type === Scalar.QUOTE_SINGLE;
  if (!inline || node.range[0] === node.range[1] || node.anchor) {
    throw new ConfigError(path, [`${dotted}: written in a form this can't change safely (empty, multi-line or anchored); set it by hand`]);
  }

  const [start, end] = node.range;
  const out = text.slice(0, start) + JSON.stringify(value) + text.slice(end);
  // A broken result is never written: this throws a ConfigError naming the problem.
  parseConfig(out, path);
  return { text: out, changed: true };
}
