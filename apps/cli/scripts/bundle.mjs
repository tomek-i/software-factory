/* global process */
// Builds the published package: the CLI and the workspace packages it uses bundled into
// dist/main.js, with the shipped prompts and the built web app next to it. npm dependencies stay
// external (better-sqlite3 is native), so they must be listed in this package's dependencies.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(cliDir, "..", "..");

/**
 * Writes `<outDir>/dist/main.js`, `<outDir>/prompts/` and `<outDir>/web/`. The `__FACTORY_BUNDLE__`
 * define tells the code that looks up those folders that they sit next to `dist/`.
 */
export async function bundle({
  entry = join(cliDir, "src", "main.ts"),
  outDir = cliDir,
  webDist = join(repoDir, "apps", "web", "dist"),
} = {}) {
  if (!existsSync(join(webDist, "index.html"))) {
    throw new Error(`No built web app in ${webDist}: run \`pnpm build\` first.`);
  }
  const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
  const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})];

  for (const dir of ["dist", "prompts", "web"]) rmSync(join(outDir, dir), { recursive: true, force: true });
  await build({
    entryPoints: [entry],
    outfile: join(outDir, "dist", "main.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // Bundle the workspace packages from their TypeScript sources, as `pnpm factory` runs them.
    conditions: ["source"],
    external,
    define: { __FACTORY_BUNDLE__: "true" },
    logLevel: "warning",
  });
  cpSync(join(repoDir, "packages", "core", "prompts"), join(outDir, "prompts"), { recursive: true });
  cpSync(webDist, join(outDir, "web"), { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle();
}
