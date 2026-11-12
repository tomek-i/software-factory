import { defineConfig } from "vitest/config";

const SOURCE_FIRST = ["source", "module", "node", "development|production"];

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources so tests never need a build first.
  // Tests run on Vite's server side, which takes its own conditions; setting them replaces Vite's
  // defaults, so those are listed too.
  resolve: { conditions: SOURCE_FIRST },
  ssr: { resolve: { conditions: SOURCE_FIRST, externalConditions: SOURCE_FIRST } },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Builds the template repos that repoWithRemote copies once per run, for every test file.
    globalSetup: ["packages/core/test/global-setup.ts"],
    // Several suites drive real git repos and child processes, which are slow on Windows.
    testTimeout: 30_000,
  },
});
