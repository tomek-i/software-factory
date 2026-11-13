import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../../test/helpers.js";

// The factory's own Playwright is missing here, so loadPlaywright has to fall back to the plugin's.
vi.mock("playwright", () => {
  throw new Error("Cannot find package 'playwright'");
});

const { loadPlaywright } = await import("./browser.js");

/** A narrate plugin in `dir`, with a stand-in Playwright in its node_modules unless `from` is undefined. Returns its narrate.mjs. */
function plugin(dir: string, from?: string): string {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "narrate.mjs"), "");
  writeFileSync(join(dir, "package.json"), '{ "name": "@narrate/plugin", "type": "module" }');
  if (from !== undefined) {
    const pw = join(dir, "node_modules", "playwright");
    mkdirSync(pw, { recursive: true });
    writeFileSync(join(pw, "package.json"), '{ "name": "playwright", "main": "index.js" }');
    writeFileSync(join(pw, "index.js"), `module.exports = { chromium: { from: ${JSON.stringify(from)} } };`);
  }
  return join(dir, "bin", "narrate.mjs");
}

/** A plugin cache holding narrate with a stand-in Playwright in its node_modules. */
function pluginWithPlaywright(): string {
  const home = tempDir("narrate-home-");
  plugin(join(home, ".claude", "plugins", "cache", "narrate-marketplace", "narrate", "1.2.3"), "the narrate plugin");
  return home;
}

async function loadedFrom(narrate: string, home?: string): Promise<string> {
  const pw = (await loadPlaywright(narrate, home)) as unknown as { chromium: { from: string } };
  return pw.chromium.from;
}

describe("loadPlaywright without the factory's own Playwright", () => {
  it("uses the copy the narrate plugin ships with, with auto", async () => {
    expect(await loadedFrom("auto", pluginWithPlaywright())).toBe("the narrate plugin");
  });

  // The import error itself, not one about the plugin (vitest wraps the mocked failure in its own message).
  it("fails with the import error when the plugin is not installed either", async () => {
    await expect(loadPlaywright("auto", tempDir("narrate-home-"))).rejects.toThrow(/mocking a module/);
  });

  it("never reaches into the plugin with off, even when the cache has one", async () => {
    await expect(loadPlaywright("off", pluginWithPlaywright())).rejects.toThrow(/mocking a module/);
  });

  it("uses the plugin a configured path belongs to", async () => {
    const cli = plugin(tempDir("narrate-path-"), "the plugin at the path");
    expect(await loadedFrom(cli, pluginWithPlaywright())).toBe("the plugin at the path");
  });

  // createRequire walks up parent node_modules folders, so a machine with a playwright above the
  // temporary folder resolves that one (as it does for auto); what must never happen is the cache.
  it("does not fall back to a plugin in the cache when the path ships no Playwright", async () => {
    const cli = plugin(tempDir("narrate-path-"));
    const loaded = (await loadPlaywright(cli, pluginWithPlaywright()).catch(() => undefined)) as { chromium?: { from?: string } } | undefined;
    expect(loaded?.chromium?.from).not.toBe("the narrate plugin");
  });

  it("fails with the import error when the configured path does not exist", async () => {
    const cli = join(tempDir("narrate-path-"), "bin", "narrate.mjs");
    await expect(loadPlaywright(cli, pluginWithPlaywright())).rejects.toThrow(/mocking a module/);
  });
});
