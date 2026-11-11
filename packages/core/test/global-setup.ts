import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlobalSetupContext } from "vitest/node";
// Declares the "repoTemplates" key.
import type {} from "./helpers.js";

/** One folder per test run for the repo templates `repoWithRemote` copies, shared by all test files. */
export default function setup({ provide }: GlobalSetupContext) {
  const dir = mkdtempSync(join(tmpdir(), "factory-templates-"));
  provide("repoTemplates", dir);
  return () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
