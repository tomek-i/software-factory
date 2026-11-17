#!/usr/bin/env node
import { ConfigError, GitError, GithubError, InitError, TransitionError } from "@factory/core";
import { CliError } from "./context.js";
import { buildProgram, styleError } from "./program.js";
import { styleFor } from "./style.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // Expected user-facing errors get a clean message; anything else keeps its stack for debugging.
  const expected = [InitError, ConfigError, CliError, GithubError, GitError, TransitionError];
  if (expected.some((type) => err instanceof type)) {
    // Errors go to stderr, so its terminal decides the colour, not stdout's.
    console.error(styleError(`error: ${(err as Error).message}`, styleFor(process.stderr)));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}
