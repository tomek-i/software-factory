#!/usr/bin/env node
/* global process, console, setTimeout */
/**
 * Stand-in for the `claude` CLI in tests (selected with FACTORY_CLAUDE_BIN), so no test spends
 * real usage. Each invocation consumes the next step of the scenario file in FAKE_CLAUDE_SCENARIO:
 *
 *   { "steps": [{ "stream": "success", "files": {"a.txt": "x"}, "exec": [["git", "commit", ...]],
 *                 "output": "STATUS: READY\nCOMMIT: {{HEAD}}\n", "exitCode": 0, "sleepMs": 0 }] }
 *
 * - files:  written relative to the agent's cwd
 * - exec:   commands run in the cwd (e.g. git commit/push)
 * - output: written to the "Output file:" named in the task on stdin; {{HEAD}} becomes HEAD's sha
 * - stream: name of a fixture in fixtures/streams, replayed on stdout with {{SESSION_ID}} filled in
 *
 * Every invocation is appended to FAKE_CLAUDE_LOG as one JSON line for assertions.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const stdin = readFileSync(0, "utf8");
const sessionId = flag("--resume") ?? flag("--session-id") ?? "no-session";
const systemPromptFile = flag("--append-system-prompt-file") ?? "";

if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      stdin,
      role: systemPromptFile.split(/[/\\]/).pop()?.replace(/\.md$/, ""),
      hasApiKey: Object.keys(process.env).some((k) => k.toUpperCase() === "ANTHROPIC_API_KEY"),
    }) + "\n",
  );
}

const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
if (!scenarioPath) {
  console.error("FAKE_CLAUDE_SCENARIO is not set");
  process.exit(2);
}
const statePath = `${scenarioPath}.state`;
const index = existsSync(statePath) ? Number(readFileSync(statePath, "utf8")) : 0;
const steps = JSON.parse(readFileSync(scenarioPath, "utf8")).steps;
const step = steps[index];
if (!step) {
  console.error(`fake claude: no scripted step #${index}`);
  process.exit(3);
}
writeFileSync(statePath, String(index + 1));

if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));

for (const [path, content] of Object.entries(step.files ?? {})) {
  const target = resolve(process.cwd(), path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
for (const [cmd, ...args] of step.exec ?? []) {
  execFileSync(cmd, args, { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"] });
}
if (step.output !== undefined) {
  const match = /^Output file: `?([^`\r\n]+)`?\s*$/m.exec(stdin);
  if (!match) {
    console.error("fake claude: no 'Output file:' line in the task");
    process.exit(4);
  }
  let content = step.output;
  if (content.includes("{{HEAD}}")) {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
    content = content.replaceAll("{{HEAD}}", head);
  }
  mkdirSync(dirname(match[1]), { recursive: true });
  writeFileSync(match[1], content);
}

const stream = readFileSync(join(here, "fixtures", "streams", `${step.stream ?? "success"}.jsonl`), "utf8");
process.stdout.write(stream.replaceAll("{{SESSION_ID}}", sessionId));
process.exit(step.exitCode ?? 0);
