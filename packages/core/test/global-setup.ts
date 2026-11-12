import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
// Declares the "repoTemplates" key.
import type {} from "./helpers.js";

/** One folder per test run for the repo templates `repoWithRemote` copies, shared by all test files. */
export default function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "factory-templates-"));
  project.provide("repoTemplates", dir);
  return () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
