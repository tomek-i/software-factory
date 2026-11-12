import { defineConfig } from "vitest/config";

// Vite 8's own defaults (not exported by vitest), with "source" in front: setting conditions
// replaces the defaults instead of adding to them.
const SERVER_CONDITIONS = ["source", "module", "node", "development|production"];
const EXTERNAL_CONDITIONS = ["source", "node", "module-sync"];

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources so tests never need a build first.
  // Tests run on Vite's server side, which takes its own conditions.
  resolve: { conditions: SERVER_CONDITIONS },
  ssr: { resolve: { conditions: SERVER_CONDITIONS, externalConditions: EXTERNAL_CONDITIONS } },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Builds the template repos that repoWithRemote copies once per run, for every test file.
    globalSetup: ["packages/core/test/global-setup.ts"],
    // Several suites drive real git repos and child processes, which are slow on Windows.
    testTimeout: 30_000,
  },
});
