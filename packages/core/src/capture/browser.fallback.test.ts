import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../../test/helpers.js";

// The factory's own Playwright is missing here, so loadPlaywright has to fall back to the plugin's.
vi.mock("playwright", () => {
  throw new Error("Cannot find package 'playwright'");
});

const { loadPlaywright } = await import("./browser.js");

/** A plugin cache holding narrate with a stand-in Playwright in its node_modules. */
function pluginWithPlaywright(): string {
  const home = tempDir("narrate-home-");
  const plugin = join(home, ".claude", "plugins", "cache", "narrate-marketplace", "narrate", "1.2.3");
  mkdirSync(join(plugin, "bin"), { recursive: true });
  writeFileSync(join(plugin, "bin", "narrate.mjs"), "");
  writeFileSync(join(plugin, "package.json"), '{ "name": "@narrate/plugin", "type": "module" }');
  const pw = join(plugin, "node_modules", "playwright");
  mkdirSync(pw, { recursive: true });
  writeFileSync(join(pw, "package.json"), '{ "name": "playwright", "main": "index.js" }');
  writeFileSync(join(pw, "index.js"), 'module.exports = { chromium: { from: "the narrate plugin" } };');
  return home;
}

describe("loadPlaywright without the factory's own Playwright", () => {
  it("uses the copy the narrate plugin ships with", async () => {
    const pw = (await loadPlaywright(pluginWithPlaywright())) as unknown as { chromium: { from: string } };
    expect(pw.chromium.from).toBe("the narrate plugin");
  });

  // The import error itself, not one about the plugin (vitest wraps the mocked failure in its own message).
  it("fails with the import error when the plugin is not installed either", async () => {
    await expect(loadPlaywright(tempDir("narrate-home-"))).rejects.toThrow(/mocking a module/);
  });
});
