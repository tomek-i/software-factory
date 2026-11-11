import { basename } from "node:path";
import type { FactoryConfig } from "@factory/shared";
import { runCommand, type CommandRunner } from "../util/exec.js";

/**
 * Hard rules: facts about a run's diff that always bring a human in, whatever the gate mode.
 * Only the run's own --unsafe flag lifts them (see resolveGate). Everything here is read from git,
 * never from what an agent says about its change.
 */

export interface ChangedFile {
  status: "A" | "M" | "D" | "T";
  path: string;
}

/** Files changed between `base` and HEAD. Renames show as a delete plus an add, so a moved file still counts as deleted. */
export function changedFiles(cwd: string, base: string, run: CommandRunner = runCommand): ChangedFile[] {
  const result = run("git", ["diff", "--name-status", "--no-renames", "-z", base, "HEAD"], { cwd });
  if (result.code !== 0) throw new Error(`git diff failed: ${result.stderr || result.stdout}`);
  const parts = result.stdout.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    files.push({ status: parts[i]![0] as ChangedFile["status"], path: parts[i + 1]! });
  }
  return files;
}

/** A glob as used in `hard_rules.paths`: `**` crosses folders, `*` and `?` stay within one. */
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
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(netrc|npmrc|pypirc)$/i,
  /^credentials(\.json)?$/i,
];

/** Dependency names declared in a manifest's text, or undefined when the file is not a manifest. */
export function declaredDependencies(path: string, text: string): Set<string> | undefined {
  const name = basename(path).toLowerCase();
  if (name === "package.json") {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Unparseable after the change: report every name we can't vouch for as new.
      return new Set(["(package.json could not be parsed)"]);
    }
    const names = new Set<string>();
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const section = json[key];
      if (section && typeof section === "object") for (const dep of Object.keys(section)) names.add(dep);
    }
    return names;
  }
  if (/\.(cs|fs|vb)proj$/.test(name) || name === "directory.packages.props" || name === "packages.config") {
    return new Set([...text.matchAll(/<(?:PackageReference|PackageVersion|package)\b[^>]*?\b(?:Include|id)\s*=\s*"([^"]+)"/gi)].map((m) => m[1]!.toLowerCase()));
  }
  if (/^requirements.*\.txt$/.test(name)) {
    const names = new Set<string>();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      if (!line || line.startsWith("-")) continue;
      const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
      if (match) names.add(match[1]!.toLowerCase().replace(/_/g, "-"));
    }
    return names;
  }
  if (name === "pyproject.toml" || name === "pipfile") return tomlDependencies(text);
  if (name === "go.mod") {
    const names = new Set<string>();
    let inBlock = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*/, "").trim();
      if (/^require\s*\($/.test(line)) inBlock = true;
      else if (inBlock && line === ")") inBlock = false;
      else if (inBlock && line) names.add(line.split(/\s+/)[0]!);
      else {
        const single = /^require\s+(\S+)\s+\S+/.exec(line);
        if (single) names.add(single[1]!);
      }
    }
    return names;
  }
  return undefined;
}

/** Names under `[...dependencies...]` / `[packages]` tables and in `dependencies = [...]` arrays. */
function tomlDependencies(text: string): Set<string> {
  const names = new Set<string>();
  const add = (spec: string) => {
    const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
    if (match) names.add(match[1]!.toLowerCase().replace(/_/g, "-"));
  };
  let table = "";
  let inArray = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (inArray) {
      for (const m of line.matchAll(/["']([^"']+)["']/g)) add(m[1]!);
      if (line.includes("]")) inArray = false;
      continue;
    }
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      table = header[1]!.trim().toLowerCase();
      continue;
    }
    const arrayStart = /^([A-Za-z0-9_.-]*dependencies|requires)\s*=\s*\[(.*)$/i.exec(line);
    if (arrayStart) {
      for (const m of arrayStart[2]!.matchAll(/["']([^"']+)["']/g)) add(m[1]!);
      inArray = !arrayStart[2]!.includes("]");
      continue;
    }
    const isDepTable = /(^|\.)(dependencies|dev-dependencies|packages|dev-packages)$/.test(table) || /\.group\.[^.]+\.dependencies$/.test(table);
    const key = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line);
    if (isDepTable && key && key[1]!.toLowerCase() !== "python") add(key[1]!);
  }
  return names;
}

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "packages.lock.json",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "go.sum",
]);

export interface HardRuleInput {
  files: ChangedFile[];
  config: FactoryConfig;
  /** A file's text at the base and at HEAD (undefined where it does not exist). */
  read: (rev: "base" | "head", path: string) => string | undefined;
  /** The issue and triage text: deleting a file they don't mention needs a human. */
  scope: string;
}

/** Every hard rule the diff trips, as short reasons for the human, e.g. "protected path: infra/main.tf". */
export function hardRuleHits({ files, config, read, scope }: HardRuleInput): string[] {
  const hits: string[] = [];
  const protectedPaths = config.hard_rules.paths.map((glob) => ({ glob, re: globToRegExp(glob) }));
  const triggers = new Set(config.hard_rules.triggers);
  const mentioned = scope.toLowerCase();

  for (const file of files) {
    const path = file.path;
    const name = basename(path);
    const match = protectedPaths.find((p) => p.re.test(path));
    if (match) hits.push(`protected path (${match.glob}): ${path}`);

    if (triggers.has("secrets_or_env_changes") && SECRET_FILE.some((re) => re.test(name))) {
      hits.push(`secret or env file changed: ${path}`);
    }

    if (triggers.has("new_dependency")) {
      if (file.status === "A" && LOCKFILES.has(name.toLowerCase())) hits.push(`new lockfile: ${path}`);
      if (file.status !== "D") {
        const after = declaredDependencies(path, read("head", path) ?? "");
        if (after) {
          const beforeText = read("base", path);
          const before = beforeText === undefined ? new Set<string>() : (declaredDependencies(path, beforeText) ?? new Set<string>());
          const added = [...after].filter((dep) => !before.has(dep)).sort();
          if (added.length) hits.push(`new dependency in ${path}: ${added.join(", ")}`);
        }
      }
    }

    if (triggers.has("deletes_files_outside_scope") && file.status === "D") {
      if (!mentioned.includes(path.toLowerCase()) && !mentioned.includes(name.toLowerCase())) {
        hits.push(`deletes a file the issue does not mention: ${path}`);
      }
    }
  }
  return hits;
}

/** Hard-rule hits for a worktree's HEAD against where its branch left the default branch. */
export function diffHardRuleHits(options: {
  cwd: string;
  defaultBranch: string;
  config: FactoryConfig;
  scope: string;
  run?: CommandRunner;
}): string[] {
  const run = options.run ?? runCommand;
  const git = (args: string[]) => run("git", args, { cwd: options.cwd });
  const mergeBase = git(["merge-base", `origin/${options.defaultBranch}`, "HEAD"]);
  if (mergeBase.code !== 0) throw new Error(`git merge-base failed: ${mergeBase.stderr || mergeBase.stdout}`);
  const base = mergeBase.stdout.trim();
  const read = (rev: "base" | "head", path: string) => {
    const shown = git(["show", `${rev === "base" ? base : "HEAD"}:${path}`]);
    return shown.code === 0 ? shown.stdout : undefined;
  };
  return hardRuleHits({ files: changedFiles(options.cwd, base, run), config: options.config, read, scope: options.scope });
}
