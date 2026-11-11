import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources so tests never need a build first.
    conditions: ["source"],
  },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Builds the template repos that repoWithRemote copies once per run, for every test file.
    globalSetup: ["packages/core/test/global-setup.ts"],
    // Several suites drive real git repos and child processes, which are slow on Windows.
    testTimeout: 30_000,
  },
});
