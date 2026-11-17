import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // apps/cli/web is the built web app, copied there for the npm package. .factory/ and .worktrees/
  // hold the factory's own runs on this repo: agents' scratch scripts and other branches' checkouts.
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "apps/cli/web/**", "apps/cli/.bundle-test-*/**", ".factory/**", ".worktrees/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
