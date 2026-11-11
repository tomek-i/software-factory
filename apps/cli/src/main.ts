#!/usr/bin/env node
import { ConfigError, GithubError, InitError } from "@factory/core";
import { CliError } from "./context.js";
import { buildProgram } from "./program.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // Expected user-facing errors get a clean message; anything else keeps its stack for debugging.
  if (err instanceof InitError || err instanceof ConfigError || err instanceof CliError || err instanceof GithubError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}
