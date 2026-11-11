import { basename } from "node:path";
import type { FactoryConfig } from "@factory/shared";
import { runCommand, type CommandRunner } from "../util/exec.js";

/**
 * Hard rules: facts about a run's diff that always bring a human in, whatever the gate mode.
 * Only the run's own --unsafe flag lifts them (see resolveGate). Everything here is read from git,
 * never from what an agent says about its change. The builder wrote the code being checked and had
 * a shell, so the rules lean towards asking: a false alarm costs a click, a miss does not.
 */

export interface ChangedFile {
  status: "A" | "M" | "D" | "T";
  path: string;
}

/** Ref the engine fetches the default branch into; the builder's refs (origin/*, replace refs) are not trusted. */
const BASE_REF = "refs/factory/hard-rules-base";

/** Git with replace objects off, so a `git replace` the builder planted cannot change what the diff shows. */
function gitIn(cwd: string, run: CommandRunner) {
  return (args: string[]) => run("git", ["--no-replace-objects", ...args], { cwd });
}

/** Files changed between `base` and `head`. Renames show as a delete plus an add, so a moved file still counts as deleted. */
export function changedFiles(cwd: string, base: string, head = "HEAD", run: CommandRunner = runCommand): ChangedFile[] {
  const result = gitIn(cwd, run)(["diff", "--name-status", "--no-renames", "-z", base, head]);
  if (result.code !== 0) throw new Error(`git diff failed: ${result.stderr || result.stdout}`);
  const parts = result.stdout.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    files.push({ status: parts[i]![0] as ChangedFile["status"], path: parts[i + 1]! });
  }
  return files;
}

/** A glob as used in `hard_rules.paths`: `**` crosses folders, `*` and `?` stay within one. The config schema rejects anything fancier. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more folders; a bare "**" matches anything.
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

const SECRET_FILE = [
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|ppk|asc|gpg|tfvars)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(netrc|pypirc)$/i,
  /^credentials(\.json)?$/i,
];

/** Files that change where dependencies come from or how they install: any change needs a human. */
const DEPENDENCY_CONFIG = new Set([
  "pnpm-workspace.yaml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "nuget.config",
  "directory.build.props",
  "directory.build.targets",
  ".gitmodules",
  "setup.py",
  "setup.cfg",
]);

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "packages.lock.json",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "go.sum",
]);

/** A version spec that only pins a version from the usual registry. Anything else (a URL, git, npm: alias, file:, a tag) is a source change. */
const PLAIN_VERSION = /^[\sv\d.^~<>=*xX|,!+-]*$/;

/** Dependencies a manifest declares, as entry -> spec, or undefined when the file is not a manifest. */
export function declaredDependencies(path: string, text: string): Map<string, string> | undefined {
  const name = basename(path).toLowerCase();
  if (name === "package.json") return packageJsonDependencies(text);
  if (/\.(cs|fs|vb)proj$/.test(name) || name === "directory.packages.props" || name === "packages.config") {
    const deps = new Map<string, string>();
    for (const m of text.matchAll(/<(?:PackageReference|PackageVersion|package)\b([^>]*)>/gi)) {
      const attrs = m[1]!;
      const id = /\b(?:Include|Update|id)\s*=\s*["']([^"']+)["']/i.exec(attrs);
      const version = /\bVersion\s*=\s*["']([^"']*)["']/i.exec(attrs);
      if (id) deps.set(id[1]!.toLowerCase(), version?.[1] ?? "");
    }
    return deps;
  }
  if (/^(requirements|constraints).*\.txt$/.test(name)) return requirementsDependencies(text);
  if (name === "pyproject.toml" || name === "pipfile") return tomlDependencies(text);
  if (name === "go.mod") return goDependencies(text);
  return undefined;
}

function packageJsonDependencies(text: string): Map<string, string> {
  const deps = new Map<string, string>();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Unparseable after the change: nothing in it can be vouched for.
    deps.set("(package.json could not be parsed)", "");
    return deps;
  }
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const section = json[key];
    if (section && typeof section === "object") {
      for (const [dep, spec] of Object.entries(section)) deps.set(dep, String(spec));
    }
  }
  // Overrides swap what an existing dependency resolves to, so every entry counts as its own dependency.
  const flatten = (prefix: string, value: unknown) => {
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) flatten(`${prefix}>${k}`, v);
    } else deps.set(prefix, String(value));
  };
  const pnpm = json.pnpm as Record<string, unknown> | undefined;
  for (const [label, section] of [
    ["overrides", json.overrides],
    ["resolutions", json.resolutions],
    ["pnpm.overrides", pnpm?.overrides],
  ] as const) {
    if (section && typeof section === "object") flatten(label, section);
  }
  return deps;
}

const pythonName = (s: string) => /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s)?.[1]?.toLowerCase().replace(/[_.]/g, "-");
/** The part of a requirement after its name and extras, e.g. ">=2" or "@ git+https://...". */
const pythonSpec = (s: string) => s.replace(/^\s*[A-Za-z0-9][A-Za-z0-9._-]*\s*(\[[^\]]*\])?/, "").trim();

function requirementsDependencies(text: string): Map<string, string> {
  const deps = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*/, "").trim();
    if (!line) continue;
    // Options (-r other.txt, -e git+..., --extra-index-url) are entries of their own: adding one is a change of source.
    if (line.startsWith("-")) deps.set(line, "");
    else {
      const name = pythonName(line);
      if (name) deps.set(name, pythonSpec(line));
    }
  }
  return deps;
}

/** Quoted strings in a TOML array that starts on `lines[i]` after `=`, and the index of its last line. */
function tomlArray(lines: string[], i: number, start: number): { items: string[]; end: number } {
  const items: string[] = [];
  let depth = 0;
  for (let j = i; j < lines.length; j++) {
    const text = j === i ? lines[j]!.slice(start) : lines[j]!;
    let quote: string | null = null;
    let current = "";
    for (const c of text) {
      if (quote) {
        if (c === quote) {
          items.push(current);
          quote = null;
          current = "";
        } else current += c;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "#") break;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) return { items, end: j };
    }
  }
  return { items, end: lines.length - 1 };
}

/** Requirements in `[...dependencies...]`, `[packages]`, optional-dependencies and dependency-groups tables, and `dependencies = [...]` arrays. */
function tomlDependencies(text: string): Map<string, string> {
  const deps = new Map<string, string>();
  const addSpec = (spec: string) => {
    const name = pythonName(spec);
    if (name) deps.set(name, pythonSpec(spec));
  };
  const lines = text.split(/\r?\n/);
  let table = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = header[1]!.toLowerCase().replace(/["']/g, "");
      continue;
    }
    const assign = /^["']?([A-Za-z0-9_.-]+)["']?\s*=\s*/.exec(line);
    if (!assign) continue;
    const key = assign[1]!.toLowerCase();
    const value = line.slice(assign[0].length);
    // Tables whose every key is a group of requirements, e.g. [project.optional-dependencies] dev = [...].
    const groupTable = /(^|\.)optional-dependencies$/.test(table) || table === "dependency-groups";
    if (value.startsWith("[") && (groupTable || /dependencies$/.test(key) || key === "requires")) {
      const offset = lines[i]!.indexOf("[", lines[i]!.indexOf("="));
      const { items, end } = tomlArray(lines, i, offset);
      items.forEach(addSpec);
      i = end;
      continue;
    }
    const depTable = /(^|\.)(dependencies|dev-dependencies|packages|dev-packages)$/.test(table) || /\.group\.[^.]+\.dependencies$/.test(table);
    if (depTable && key !== "python") deps.set(key.replace(/[_.]/g, "-"), value);
  }
  return deps;
}

function goDependencies(text: string): Map<string, string> {
  const deps = new Map<string, string>();
  let block: "require" | "replace" | null = null;
  const add = (kind: "require" | "replace", entry: string) => {
    if (kind === "require") {
      const [mod, version = ""] = entry.split(/\s+/);
      if (mod) deps.set(mod, version);
    } else {
      // replace a/b [v] => c/d [v]: the entry is the left side, the spec where it now comes from.
      const [left, right = ""] = entry.split("=>").map((s) => s.trim());
      if (left) deps.set(`replace ${left}`, right);
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*/, "").trim();
    const open = /^(require|replace)\s*\($/.exec(line);
    if (open) block = open[1] as "require" | "replace";
    else if (block && line === ")") block = null;
    else if (block && line) add(block, line);
    else {
      const single = /^(require|replace)\s+(.+)$/.exec(line);
      if (single) add(single[1] as "require" | "replace", single[2]!);
    }
  }
  return deps;
}

export interface HardRuleInput {
  files: ChangedFile[];
  config: FactoryConfig;
  /** A file's text at the base and at the checked commit (undefined where it does not exist). */
  read: (rev: "base" | "head", path: string) => string | undefined;
  /** The issue and triage text: deleting a file they don't name needs a human. */
  scope: string;
}

/** Whether `text` names `path` as a whole path, not as part of a longer name ("a.ts" is not in "data.ts" or "a.tsx"). */
function mentions(text: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w./-])${escaped}(?![\\w/-]|\\.\\w)`, "i").test(text);
}

/** Every hard rule the diff trips, as short reasons for the human, e.g. "protected path (infra/**): infra/main.tf". */
export function hardRuleHits({ files, config, read, scope }: HardRuleInput): string[] {
  const hits: string[] = [];
  const protectedPaths = config.hard_rules.paths.map((glob) => ({ glob, re: globToRegExp(glob) }));
  const triggers = new Set(config.hard_rules.triggers);

  for (const file of files) {
    const path = file.path;
    const name = basename(path);
    const lower = name.toLowerCase();
    const match = protectedPaths.find((p) => p.re.test(path));
    if (match) hits.push(`protected path (${match.glob}): ${path}`);

    if (triggers.has("secrets_or_env_changes") && SECRET_FILE.some((re) => re.test(name))) {
      hits.push(`secret or env file changed: ${path}`);
    }

    if (triggers.has("new_dependency")) {
      if (LOCKFILES.has(lower)) hits.push(`lockfile ${file.status === "A" ? "added" : file.status === "D" ? "deleted" : "changed"}: ${path}`);
      if (DEPENDENCY_CONFIG.has(lower)) hits.push(`dependency config changed: ${path}`);
      if (file.status !== "D") {
        const after = declaredDependencies(path, read("head", path) ?? "");
        if (after) {
          const beforeText = read("base", path);
          const before = (beforeText === undefined ? undefined : declaredDependencies(path, beforeText)) ?? new Map<string, string>();
          const added = [...after.keys()].filter((dep) => !before.has(dep)).sort();
          if (added.length) hits.push(`new dependency in ${path}: ${added.join(", ")}`);
          const moved = [...after]
            .filter(([dep, spec]) => before.has(dep) && before.get(dep) !== spec && (dep.startsWith("replace ") || !PLAIN_VERSION.test(spec)))
            .map(([dep, spec]) => `${dep} (${spec})`)
            .sort();
          if (moved.length) hits.push(`dependency source changed in ${path}: ${moved.join(", ")}`);
        }
      }
    }

    if (triggers.has("deletes_files_outside_scope") && file.status === "D" && !mentions(scope, path)) {
      hits.push(`deletes a file the issue does not name by its path: ${path}`);
    }
  }
  return hits;
}

/**
 * Where `head` left the default branch, from a fresh fetch of the remote into an engine-owned ref:
 * the builder could have moved origin/<branch> or planted replace refs in the shared repository.
 */
export function freshBase(cwd: string, defaultBranch: string, head = "HEAD", run: CommandRunner = runCommand): string {
  const git = gitIn(cwd, run);
  const fetched = git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${defaultBranch}:${BASE_REF}`]);
  if (fetched.code !== 0) throw new Error(`git fetch of ${defaultBranch} failed: ${fetched.stderr || fetched.stdout}`);
  const mergeBase = git(["merge-base", BASE_REF, head]);
  if (mergeBase.code !== 0) throw new Error(`git merge-base failed: ${mergeBase.stderr || mergeBase.stdout}`);
  return mergeBase.stdout.trim();
}

/**
 * Hard-rule hits for the commit `head` (default HEAD) against where it left the default branch.
 * The base comes from a fresh fetch of the remote into an engine-owned ref, because the builder
 * could have moved origin/<branch> or planted replace refs in the shared repository.
 */
export function diffHardRuleHits(options: {
  cwd: string;
  defaultBranch: string;
  config: FactoryConfig;
  scope: string;
  head?: string;
  run?: CommandRunner;
}): string[] {
  const run = options.run ?? runCommand;
  const git = gitIn(options.cwd, run);
  const head = options.head ?? "HEAD";
  const base = freshBase(options.cwd, options.defaultBranch, head, run);
  const read = (rev: "base" | "head", path: string) => {
    const shown = git(["show", `${rev === "base" ? base : head}:${path}`]);
    return shown.code === 0 ? shown.stdout : undefined;
  };
  return hardRuleHits({ files: changedFiles(options.cwd, base, head, run), config: options.config, read, scope: options.scope });
}
