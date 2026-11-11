#!/usr/bin/env node
import { ConfigError, GitError, GithubError, InitError, TransitionError } from "@factory/core";
import { CliError } from "./context.js";
import { buildProgram } from "./program.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // Expected user-facing errors get a clean message; anything else keeps its stack for debugging.
  const expected = [InitError, ConfigError, CliError, GithubError, GitError, TransitionError];
  if (expected.some((type) => err instanceof type)) {
    console.error(`error: ${(err as Error).message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}
