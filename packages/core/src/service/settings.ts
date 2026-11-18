import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { DEFAULT_PROTECTED_PATHS, defaultConfig, SETTING_SECTIONS, SETTINGS, valueAt, type FactoryConfig, type Setting } from "@factory/shared";
import { editConfigText, type ConfigChange } from "../config/edit.js";
import { CONFIG_FILE, ConfigError, FACTORY_DIR, parseConfig } from "../config/load.js";
import { trustedReader } from "../config/trusted.js";
import { commitToRemote } from "../git/commit-remote.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { ServiceError } from "./errors.js";
import type { ProjectContext } from "./project.js";

const CONFIG_PATH = `${FACTORY_DIR}/${CONFIG_FILE}`;

/** The settings changed on the default branch after they were read: saving would overwrite that. */
export class SettingsChanged extends ServiceError {}

export interface SettingView extends Setting {
  /** What the file sets, or undefined when it leaves the setting to the default. */
  value?: unknown;
  /** What runs use: the file's value or the default. */
  effective?: unknown;
  default?: unknown;
}

export interface ProjectSettings {
  /** The branch the settings are read from and saved to. */
  branch: string;
  /** The commit of that branch they were read at; a save must name it. */
  head: string;
  sections: typeof SETTING_SECTIONS;
  settings: SettingView[];
  /** The protected paths every project has; `hard_rules.paths` only adds to them. */
  builtinPaths: readonly string[];
  /** Why the file on the branch is not a valid config; the page then shows the defaults. */
  problems: string[];
}

function views(raw: unknown, effective: FactoryConfig): SettingView[] {
  const defaults = defaultConfig();
  return SETTINGS.map((setting) => ({
    ...setting,
    value: valueAt(raw, setting.path),
    effective: setting.path === "hard_rules.paths" ? valueAt(raw, setting.path) : valueAt(effective, setting.path),
    default: setting.path === "hard_rules.paths" ? [] : valueAt(defaults, setting.path),
  }));
}

/** The project's settings as runs use them: `.factory/config.yaml` on the remote default branch. */
export function readSettings(ctx: ProjectContext, run: CommandRunner = runCommand): ProjectSettings {
  const branch = ctx.config.project.default_branch;
  const read = trustedReader(ctx.root, branch, run);
  const head = run("git", ["rev-parse", `origin/${branch}`], { cwd: ctx.root });
  if (head.code !== 0) throw new ServiceError(`Could not read origin/${branch}: ${head.stderr}`);
  const text = read(CONFIG_PATH);
  const source = `origin/${branch}:${CONFIG_PATH}`;
  let raw: unknown;
  let effective = defaultConfig();
  let problems: string[] = [];
  if (text === undefined) {
    problems = [`${source}: not found; commit and push .factory/config.yaml first`];
  } else {
    try {
      raw = parse(text);
      effective = parseConfig(text, source);
    } catch (err) {
      problems = err instanceof ConfigError ? err.problems.map((p) => `${source}: ${p}`) : [(err as Error).message];
    }
  }
  return { branch, head: head.stdout.trim(), sections: SETTING_SECTIONS, settings: views(raw, effective), builtinPaths: DEFAULT_PROTECTED_PATHS, problems };
}

export interface SavedSettings {
  commit: string;
  branch: string;
  changed: string[];
  config: FactoryConfig;
}

/**
 * Change settings by committing `.factory/config.yaml` to the remote default branch, where runs
 * read it. Refuses when the branch moved since `head`, so a change made meanwhile is never lost;
 * the push is never forced, so branch protection refuses it rather than being bypassed.
 */
export function saveSettings(
  ctx: ProjectContext,
  request: { head: string; changes: ConfigChange[] },
  run: CommandRunner = runCommand,
): SavedSettings {
  if (!request.changes.length) throw new ServiceError("No settings to change.");
  const editable = new Map(SETTINGS.map((s) => [s.path, s]));
  for (const change of request.changes) {
    const setting = editable.get(change.path);
    if (!setting) throw new ServiceError(`${change.path} is not a setting.`);
    if (setting.readOnly) throw new ServiceError(`${change.path} can't be changed here: ${setting.readOnly}`);
  }
  const branch = ctx.config.project.default_branch;
  const changed = request.changes.map((c) => c.path);
  let config: FactoryConfig | undefined;
  try {
    const commit = commitToRemote({
      root: ctx.root,
      run,
      base: branch,
      branch,
      check: (current) => {
        if (current !== request.head) throw new SettingsChanged(`The settings on ${branch} changed since you opened them. Reload to see the change, then make yours again.`);
      },
      write: (worktree) => {
        const file = join(worktree, CONFIG_PATH);
        if (!existsSync(file)) throw new ServiceError(`${branch} has no ${CONFIG_PATH}; commit and push it first.`);
        const text = editConfigText(readFileSync(file, "utf8"), request.changes, `origin/${branch}:${CONFIG_PATH}`);
        config = parseConfig(text);
        writeFileSync(file, text);
        return [CONFIG_PATH];
      },
      message: `chore(factory): change settings: ${changed.join(", ")}`,
      what: "the settings commit",
      tempPrefix: "factory-settings-",
    });
    return { commit, branch, changed, config: config! };
  } catch (err) {
    if (err instanceof ServiceError) throw err;
    if (err instanceof ConfigError) throw new ServiceError(err.problems.join("\n"));
    const message = (err as Error).message;
    if (message.startsWith("git push failed")) {
      throw new ServiceError(`${branch} refused the push, so nothing was changed (branch protection, or a push made meanwhile): ${message.slice("git push failed: ".length)}`);
    }
    throw new ServiceError(message);
  }
}
