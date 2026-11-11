#!/usr/bin/env node
import { ConfigError, InitError } from "@factory/core";
import { buildProgram } from "./program.js";

try {
  await buildProgram().parseAsync(process.argv);
} catch (err) {
  // Expected user-facing errors get a clean message; anything else keeps its stack for debugging.
  if (err instanceof InitError || err instanceof ConfigError) {
    console.error(`error: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}
