import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterAll } from "vitest";

// Unit tests stay fast because they start no processes: no git, no fake `claude`, no app, no
// Chromium. A test that needs one is an integration test and belongs in a `*.int.test.ts` file, so a
// unit test that tries is stopped here instead of quietly slowing down `pnpm test:unit`.
const BLOCKED = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

/** Every process a unit test tried to start in this file; exported so the guard's own test can clear it. */
export const blockedCalls: string[] = [];

const target = childProcess as unknown as Record<string, unknown>;
for (const name of BLOCKED) {
  target[name] = (command: unknown) => {
    const call = `${name}(${JSON.stringify(String(command))})`;
    blockedCalls.push(call);
    throw new Error(`A unit test started a child process, ${call}: name the file *.int.test.ts to make it an integration test.`);
  };
}
// Points the named exports (`import { spawn } from "node:child_process"`) at the replacements too.
syncBuiltinESMExports();

// Code under test may catch the error above (a runner that reports a failed command, a browser
// check that answers "not installed"), so the file fails here even when no test did.
afterAll(() => {
  if (blockedCalls.length > 0) {
    throw new Error(`Unit tests started child processes: ${blockedCalls.join(", ")}. Name the file *.int.test.ts.`);
  }
});
