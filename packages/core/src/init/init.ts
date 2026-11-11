import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, FACTORY_DIR, loadConfig } from "../config/load.js";
import { factoryLabels } from "../github/labels.js";
import { Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { findRepoRoot, githubLogin, githubRepoOf } from "../util/git.js";
import { detectProject, type Detection } from "./detect.js";
import { renderConfig } from "./template.js";

export const GITIGNORE_ENTRIES = [".factory/runs/", ".factory/factory.db*", ".worktrees/"];

export interface InitOptions {
  cwd: string;
  run?: CommandRunner;
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
export function ensureGitignore(root: string, entries: string[] = GITIGNORE_ENTRIES): string[] {
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const present = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0) return [];

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
  const root = findRepoRoot(options.cwd, run);
  if (!root) throw new InitError("Not inside a git repository. Run `git init` first, or cd into your project.");

  const steps: InitResult["steps"] = [];
  const detection = detectProject(root);
  const githubRepo = githubRepoOf(root, run);

  const factoryDir = join(root, FACTORY_DIR);
  mkdirSync(factoryDir, { recursive: true });

  const configFile = join(factoryDir, CONFIG_FILE);
  if (existsSync(configFile)) {
    steps.push({ status: "skipped", message: `${FACTORY_DIR}/${CONFIG_FILE} already exists, left unchanged` });
  } else {
    writeFileSync(configFile, renderConfig(detection, { operatorLogin: githubLogin(root, run) }));
    const found = detection.checks.map((c) => c.name).join(", ") || "none - add them by hand";
    steps.push({ status: "done", message: `Wrote ${FACTORY_DIR}/${CONFIG_FILE} (checks: ${found})` });
  }
  // Validate whatever is on disk now, so a broken hand-edited config is reported straight away.
  const config = loadConfig(root);

  const lessons = join(factoryDir, "lessons.md");
  if (!existsSync(lessons)) {
    writeFileSync(lessons, "# Lessons\n\nApproved lessons from past runs. Agents read this file before they start.\n");
    steps.push({ status: "done", message: `Wrote ${FACTORY_DIR}/lessons.md` });
  }

  const added = ensureGitignore(root);
  steps.push(
    added.length
      ? { status: "done", message: `Added ${added.join(", ")} to .gitignore` }
      : { status: "skipped", message: ".gitignore already ignores factory state" },
  );

  const store = new Store(join(factoryDir, "factory.db"));
  try {
    store.upsertProject({ name: config.project.name ?? detection.projectName, repo_path: root, github_repo: githubRepo });
  } finally {
    store.close();
  }
  steps.push({ status: "done", message: `Registered project in ${FACTORY_DIR}/factory.db` });

  if (!config.github.status_labels) {
    steps.push({ status: "skipped", message: "GitHub status labels (off; set github.status_labels to enable)" });
  } else if (!githubRepo) {
    steps.push({ status: "warning", message: "No GitHub origin remote found; skipped creating labels" });
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
