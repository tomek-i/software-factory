import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { GIT_TEST_TIMEOUT } from "../../../packages/core/test/helpers.js";
import { bundle } from "../scripts/bundle.mjs";

// Bundling the whole CLI and starting node on it takes seconds alone and many times that while a full
// `pnpm test` keeps the machine busy.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const cliDir = resolve(fileURLToPath(import.meta.url), "..", "..");
// Inside this package, so the bundle's external npm dependencies resolve from its node_modules.
const scratch = mkdtempSync(join(cliDir, ".bundle-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A stand-in for apps/web/dist, so the test needs no web build.
const webDist = join(scratch, "web-dist");
mkdirSync(webDist);
writeFileSync(join(webDist, "index.html"), "<!doctype html>");

describe("the npm package bundle", () => {
  it("runs the CLI with only npm dependencies left to install", async () => {
    const outDir = join(scratch, "cli");
    await bundle({ outDir, webDist });
    const version = (JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")) as { version: string }).version;
    expect(execFileSync(process.execPath, [join(outDir, "dist", "main.js"), "--version"], { encoding: "utf8" }).trim()).toBe(version);
    expect(readFileSync(join(outDir, "dist", "main.js"), "utf8")).not.toMatch(/from "@factory\//);

    // What `factory upgrade` reads the leases with, in a child process; no projects here.
    const env = { ...process.env, FACTORY_DATA_DIR: join(scratch, "data") };
    expect(execFileSync(process.execPath, [join(outDir, "dist", "main.js"), "upgrade", "--list-leases"], { encoding: "utf8", env }).trim()).toBe("[]");
    // A bundle outside node_modules is a checkout's build, which `git pull` updates; refused before any lookup.
    expect(() => execFileSync(process.execPath, [join(outDir, "dist", "main.js"), "upgrade"], { encoding: "utf8", env, stdio: "pipe" })).toThrow(/git pull/);
  });

  it("finds the shipped prompts and the web app next to dist/", async () => {
    const outDir = join(scratch, "paths");
    const entry = join(scratch, "paths-entry.ts");
    writeFileSync(
      entry,
      [
        `import { SHIPPED_PROMPTS_DIR } from "@factory/core";`,
        `import { defaultWebRoot } from "@factory/server";`,
        `console.log(JSON.stringify({ prompts: SHIPPED_PROMPTS_DIR, web: defaultWebRoot() }));`,
      ].join("\n"),
    );
    await bundle({ entry, outDir, webDist });
    const paths = JSON.parse(execFileSync(process.execPath, [join(outDir, "dist", "main.js")], { encoding: "utf8" })) as { prompts: string; web: string };
    expect(resolve(paths.prompts)).toBe(join(outDir, "prompts"));
    expect(resolve(paths.web)).toBe(join(outDir, "web"));
    expect(existsSync(join(paths.prompts, "builder.md"))).toBe(true);
    expect(existsSync(join(paths.web, "index.html"))).toBe(true);
  });

  it("lists every npm dependency of the bundled packages, with the same range", () => {
    // esbuild inlines a dependency missing from the cli's list instead of failing, which breaks
    // native or CommonJS packages only at runtime, for npm users.
    type Manifest = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    const manifest = (dir: string) => JSON.parse(readFileSync(join(cliDir, "..", "..", dir, "package.json"), "utf8")) as Manifest;
    const cli = manifest("apps/cli");
    for (const dir of ["packages/shared", "packages/core", "apps/server"]) {
      const pkg = manifest(dir);
      for (const field of ["dependencies", "optionalDependencies"] as const) {
        for (const [name, range] of Object.entries(pkg[field] ?? {})) {
          if (range.startsWith("workspace:")) continue;
          expect(cli[field]?.[name], `${dir} ${field} ${name}`).toBe(range);
        }
      }
    }
  });

  it("refuses to bundle without a built web app", async () => {
    await expect(bundle({ outDir: join(scratch, "no-web"), webDist: join(scratch, "missing") })).rejects.toThrow(/No built web app/);
  });
});
