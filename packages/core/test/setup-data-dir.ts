import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Every test file gets its own factory data folder, so `factory init` in a test never adds a temp
// repo to the user's real project list, and test files can't see each other's.
const dir = mkdtempSync(join(tmpdir(), "factory-data-"));
process.env.FACTORY_DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
