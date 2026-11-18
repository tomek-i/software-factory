import { isMap, parseDocument } from "yaml";
import { ConfigError, CONFIG_FILE, parseConfig } from "./load.js";
import { resetConfigText } from "./reset.js";

/** A list written with its `- ` at the same indentation as its key. */
const UNINDENTED_LIST = /^( *)[^\s#-][^\n]*:[ \t]*\r?\n\1- /m;

/** One change to a setting: a new value, or back to the default (taken out of the file). */
export type ConfigChange = { path: string; value: unknown } | { path: string; reset: true };

/**
 * Apply changes to config text, keeping comments and the order of the settings it doesn't touch.
 * A setting that is set is written out again, so comments inside a list or map it replaces go; a
 * reset takes the setting out (and its comment, and a section left empty), so the default applies.
 * The result is checked like any config, so broken text is never returned.
 */
export function editConfigText(text: string, changes: ConfigChange[], path: string = CONFIG_FILE): string {
  const paths = changes.map((c) => c.path);
  const twice = paths.filter((p, i) => paths.indexOf(p) !== i || paths.some((q) => q !== p && q.startsWith(`${p}.`)));
  if (twice.length) throw new ConfigError(path, [...new Set(twice)].map((p) => `${p}: changed more than once`));

  const resets = changes.filter((c) => "reset" in c).map((c) => c.path);
  let out = resets.length ? resetConfigText(text, { paths: resets }, path).text : text;

  const sets = changes.filter((c): c is { path: string; value: unknown } => "value" in c);
  if (sets.length) {
    const doc = parseDocument(out);
    if (doc.errors.length) throw new ConfigError(path, doc.errors.map((e) => `YAML syntax: ${e.message}`));
    if (!isMap(doc.contents)) throw new ConfigError(path, ["(root): expected a mapping of settings"]);
    for (const change of sets) {
      try {
        doc.setIn(change.path.split("."), change.value);
      } catch (err) {
        // An alias (`gates: *shared`) or a scalar where a section belongs.
        throw new ConfigError(path, [`${change.path}: written in a form this can't change safely (${(err as Error).message}); set it by hand`]);
      }
    }
    // No line width: a long command must stay on one line, as it was written. Lists keep the file's
    // own indentation (`- ` under its key, or indented), so untouched ones don't change.
    out = doc.toString({ lineWidth: 0, indentSeq: !UNINDENTED_LIST.test(out) });
    if (text.includes("\r\n")) out = out.replace(/\r?\n/g, "\r\n");
  }
  // A broken result is never returned: this throws a ConfigError naming the problem.
  parseConfig(out, path);
  return out;
}
