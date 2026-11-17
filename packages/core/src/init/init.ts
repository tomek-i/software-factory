import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, FACTORY_DIR, parseConfig } from "../config/load.js";
import { setConfigValue } from "../config/set.js";
import { factoryLabels } from "../github/labels.js";
import { listRegistered, registerProject, sameProjectPath } from "../registry.js";
import { Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { findRepoRoot, githubLogin, githubRepoOf } from "../util/git.js";
import { detectProject, type Detection } from "./detect.js";
import { renderConfig } from "./template.js";

export const GITIGNORE_ENTRIES = [".factory/runs/", ".factory/factory.db*", ".worktrees/", ".factory/drafts/"];

export interface InitOptions {
  cwd: string;
  run?: CommandRunner;
  /** The project list to add the repo to; defaults to the user's (`registryPath()`). */
  registryFile?: string;
  /** Sets `project.name`, in a new config or the existing one, instead of the detected name. */
  name?: string;
  /** Sets `github.status_labels: true`, so the labels are created. */
  labels?: boolean;
  /** Works out every step but writes nothing: no files, database, project list or labels. */
  dryRun?: boolean;
}

export interface InitResult {
  root: string;
  githubRepo?: string;
  detection: Detection;
  /** Human-readable lines describing what happened, in order. */
  steps: { status: "done" | "skipped" | "warning"; message: string }[];
}

export class InitError extends Error {}

/** Add missing lines to .gitignore without touching existing content or line endings. */
export function ensureGitignore(root: string, entries: string[] = GITIGNORE_ENTRIES, dryRun = false): string[] {
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0 || dryRun) return missing;

  const prefix = current === "" || current.endsWith("\n") ? "" : eol;
  const block = ["# software factory runtime state", ...missing].join(eol) + eol;
  writeFileSync(path, current + prefix + (current === "" ? "" : eol) + block);
  return missing;
}

/**
 * Set a repository up for the factory. Safe to re-run: existing config is kept,
 * and everything else is only added when missing.
 */
export function initRepo(options: InitOptions): InitResult {
  const run = options.run ?? runCommand;
  const dryRun = options.dryRun ?? false;
  const root = findRepoRoot(options.cwd, run);
  if (!root) throw new InitError("Not inside a git repository. Run `git init` first, or cd into your project.");
  if (options.name !== undefined && options.name.trim() === "") throw new InitError("The project name can't be empty.");

  const steps: InitResult["steps"] = [];
  const done = (now: string, later: string) => (dryRun ? `Would ${later}` : now);
  const detection = detectProject(root);
  const githubRepo = githubRepoOf(root, run);

  const factoryDir = join(root, FACTORY_DIR);
  const configFile = join(factoryDir, CONFIG_FILE);
  const configName = `${FACTORY_DIR}/${CONFIG_FILE}`;
  const existed = existsSync(configFile);
  let text = existed
    ? readFileSync(configFile, "utf8")
    : renderConfig({ ...detection, projectName: options.name ?? detection.projectName }, { operatorLogin: githubLogin(root, run) });
  // Worked out before anything is written, so a flag that can't be applied leaves the repo as it was.
  const set: string[] = [];
  const apply = (setting: string, value: string | boolean) => {
    const result = setConfigValue(text, setting, value, configFile);
    text = result.text;
    if (result.changed) set.push(`${setting} to ${JSON.stringify(value)}`);
  };
  if (existed && options.name !== undefined) apply("project.name", options.name);
  if (options.labels) apply("github.status_labels", true);
  // Validate the text that will be on disk, so a broken hand-edited config is reported straight away.
  const config = parseConfig(text, configFile);

  if (!dryRun) {
    mkdirSync(factoryDir, { recursive: true });
    if (!existed || set.length) writeFileSync(configFile, text);
  }
  if (!existed) {
    const found = detection.checks.map((c) => c.name).join(", ") || "none - add them by hand";
    steps.push({ status: "done", message: `${done("Wrote", "write")} ${configName} (checks: ${found})` });
  } else if (set.length) {
    steps.push({ status: "done", message: `${done("Set", "set")} ${set.join(", ")} in ${configName}` });
  } else {
    steps.push({ status: "skipped", message: `${configName} already exists, left unchanged (\`factory config reset\` brings settings back to the defaults)` });
  }

  const lessons = join(factoryDir, "lessons.md");
  if (!existsSync(lessons)) {
    if (!dryRun) writeFileSync(lessons, "# Lessons\n\nApproved lessons from past runs. Agents read this file before they start.\n");
    steps.push({ status: "done", message: `${done("Wrote", "write")} ${FACTORY_DIR}/lessons.md` });
  }

  const added = ensureGitignore(root, GITIGNORE_ENTRIES, dryRun);
  steps.push(
    added.length
      ? { status: "done", message: `${done("Added", "add")} ${added.join(", ")} to .gitignore` }
      : { status: "skipped", message: ".gitignore already ignores factory state" },
  );

  const name = config.project.name ?? detection.projectName;
  if (!dryRun) {
    const store = new Store(join(factoryDir, "factory.db"));
    try {
      store.upsertProject({ name, repo_path: root, github_repo: githubRepo });
    } finally {
      store.close();
    }
  }
  steps.push({ status: "done", message: `${done("Registered", "register")} project in ${FACTORY_DIR}/factory.db` });

  // The repo itself is set up by now, so a project list that can't be written is a warning:
  // running init again adds it.
  try {
    const listed = dryRun ? registryChange(root, name, options.registryFile) : registerProject({ path: root, name }, { file: options.registryFile });
    const message =
      listed === "added"
        ? done("Added to the factory's project list", "add it to the factory's project list")
        : done("Updated its name in the factory's project list", "update its name in the factory's project list");
    steps.push(listed === "unchanged" ? { status: "skipped", message: "Already in the factory's project list" } : { status: "done", message });
  } catch (err) {
    steps.push({ status: "warning", message: `Could not ${dryRun ? "read" : "add it to"} the factory's project list: ${err instanceof Error ? err.message : String(err)}` });
  }

  if (!config.github.status_labels) {
    steps.push({ status: "skipped", message: "GitHub status labels (off; `factory init --labels` turns them on)" });
  } else if (!githubRepo) {
    steps.push({ status: "warning", message: "No GitHub origin remote found; skipped creating labels" });
  } else if (dryRun) {
    steps.push({ status: "done", message: `Would create factory labels on ${githubRepo}` });
  } else {
    const failed: string[] = [];
    for (const label of factoryLabels(config.github.label_prefix)) {
      const result = run(
        "gh",
        ["label", "create", label.name, "--color", label.color, "--description", label.description, "--force", "-R", githubRepo],
        { cwd: root },
      );
      if (result.code !== 0) failed.push(`${label.name} (${result.stderr || "gh failed"})`);
    }
    steps.push(
      failed.length
        ? { status: "warning", message: `Could not create labels on ${githubRepo}: ${failed.join("; ")}` }
        : { status: "done", message: `Created factory labels on ${githubRepo}` },
    );
  }

  return { root, githubRepo, detection, steps };
}

/** What `registerProject` would do, without writing the project list. */
function registryChange(root: string, name: string, file?: string): "added" | "updated" | "unchanged" {
  const existing = listRegistered({ file }).find((e) => sameProjectPath(e.path, root));
  if (!existing) return "added";
  return existing.name === name ? "unchanged" : "updated";
}
