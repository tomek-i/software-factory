import { configDefaults, defineConfig } from "vitest/config";
import { GIT_TEST_TIMEOUT } from "./packages/core/test/helpers.js";

// Vite 8's own defaults (not exported by vitest), with "source" in front: setting conditions
// replaces the defaults instead of adding to them.
const SERVER_CONDITIONS = ["source", "module", "node", "development|production"];
const EXTERNAL_CONDITIONS = ["source", "node", "module-sync"];

// Integration tests start processes (git repos, the fake `claude`, apps, Chromium) and take
// minutes; unit tests start none and take seconds. The name decides: `*.int.test.ts` is integration.
const INTEGRATION = "**/*.int.test.ts";

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources so tests never need a build first.
  // Tests run on Vite's server side, which takes its own conditions.
  resolve: { conditions: SERVER_CONDITIONS },
  ssr: { resolve: { conditions: SERVER_CONDITIONS, externalConditions: EXTERNAL_CONDITIONS } },
  test: {
    // Builds the template repos that repoWithRemote copies once per run, for every test file.
    globalSetup: ["packages/core/test/global-setup.ts"],
    // Points FACTORY_DATA_DIR at a temp folder, so no test touches the real project list.
    setupFiles: ["packages/core/test/setup-data-dir.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // The web app's tests (.tsx) pick jsdom themselves with a @vitest-environment comment.
          include: ["{apps,packages}/*/src/**/*.test.ts", "apps/web/src/**/*.test.tsx", "packages/*/test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, INTEGRATION],
          // Fails a unit test that starts a process: it belongs in a *.int.test.ts file.
          setupFiles: ["packages/core/test/no-child-processes.ts"],
          // Fast alone, but `pnpm test` runs them beside the integration tests, which load the machine.
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["{apps,packages}/*/src/**/*.int.test.ts", "packages/*/test/**/*.int.test.ts"],
          // Real git repos and child processes are slow on Windows, and much slower on a busy machine.
          testTimeout: GIT_TEST_TIMEOUT,
        },
      },
    ],
  },
});
