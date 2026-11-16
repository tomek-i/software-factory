import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // apps/cli/web is the built web app, copied there for the npm package.
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "apps/cli/web/**", "apps/cli/.bundle-test-*/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
