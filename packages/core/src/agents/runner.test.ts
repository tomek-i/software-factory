import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeClaude, tempDir, type FakeStep } from "../../test/helpers.js";
import { FactoryEvents, type FactoryEvent } from "../events.js";
import { Store } from "../store/store.js";
import { agentEnv, claudeArgs, claudeCommand, createAgentRunner, type AgentRunOptions } from "./runner.js";

function setup(steps: FakeStep[], extraEnv: NodeJS.ProcessEnv = {}) {
  const fake = fakeClaude(steps);
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: "/repo" });
  const run = store.createRun({ project_id: project.id, title: "t", issue_number: 1 });
  const events = new FactoryEvents();
  const seen: FactoryEvent[] = [];
  events.on((e) => seen.push(e));
  const dir = tempDir();
  const promptFile = join(dir, "role.md");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(promptFile, "You are a test agent.");
  writeFileSync(settingsFile, "{}");
  const runner = createAgentRunner({ store, events, env: { ...fake.env, ...extraEnv } });
  const options = (overrides: Partial<AgentRunOptions> = {}): AgentRunOptions => ({
    runId: run.id,
    role: "triage",
    model: "opus",
    cwd: dir,
    prompt: `Do the thing.\n\nOutput file: ${join(dir, "out.md")}\n`,
    systemPromptFile: promptFile,
    settingsFile,
    logDir: join(dir, "logs"),
    ...overrides,
  });
  return { fake, store, run, runner, options, seen, dir };
}

describe("agentEnv", () => {
  it("removes ANTHROPIC_API_KEY in any casing so runs use the subscription", () => {
    const env = agentEnv({ ANTHROPIC_API_KEY: "sk-ant-x", anthropic_api_key: "y", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });

  it("switches auto-memory off even if the caller's env tried to enable it", () => {
    const env = agentEnv({ claude_code_disable_auto_memory: "0", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });
});

describe("claudeArgs", () => {
  const base = {
    runId: "r",
    role: "builder",
    model: "sonnet",
    cwd: "/w",
    prompt: "",
    systemPromptFile: "/p/builder.md",
    settingsFile: "/p/builder.json",
    logDir: "/l",
  };

  it("starts a new session with stream-json, the role prompt and its permission profile", () => {
    const args = claudeArgs({ ...base, maxTurns: 40, addDirs: ["/runs/1"] }, "sess-1");
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--output-format", "stream-json", "--verbose", "--session-id", "sess-1"]),
    );
    expect(args.join(" ")).toContain("--append-system-prompt-file /p/builder.md");
    expect(args.join(" ")).toContain("--settings /p/builder.json");
    expect(args.join(" ")).toContain("--permission-mode dontAsk");
    expect(args.join(" ")).toContain("--max-turns 40");
    expect(args.join(" ")).toContain("--add-dir /runs/1");
    expect(args).not.toContain("--bare");
  });

  it("ignores the user's and the repo's own settings and MCP servers", () => {
    const args = claudeArgs(base, "sess-1");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: {} });
  });

  it("passes --effort only when one is configured", () => {
    expect(claudeArgs(base, "sess-1")).not.toContain("--effort");
    const args = claudeArgs({ ...base, effort: "low" }, "sess-1");
    expect(args.join(" ")).toContain("--model sonnet");
    expect(args.join(" ")).toContain("--effort low");
  });

  it("resumes an existing session", () => {
    const args = claudeArgs({ ...base, resumeSessionId: "sess-1" }, "sess-1");
    expect(args.join(" ")).toContain("--resume sess-1");
    expect(args).not.toContain("--session-id");
  });
});

describe("claudeCommand", () => {
  it("defaults to claude and runs a .mjs override with node", () => {
    expect(claudeCommand({})).toEqual({ file: "claude", args: [] });
    expect(claudeCommand({ FACTORY_CLAUDE_BIN: "/x/fake.mjs" })).toEqual({ file: process.execPath, args: ["/x/fake.mjs"] });
    expect(claudeCommand({ FACTORY_CLAUDE_BIN: "/x/claude.exe" })).toEqual({ file: "/x/claude.exe", args: [] });
  });
});

describe("createAgentRunner", () => {
  it("returns session, cost, tokens and log path, and records the agent run", async () => {
    const { runner, options, store, run, fake, seen } = setup([{ stream: "success", output: "DECISION: APPROVE\n" }], {
      ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
    });

    const result = await runner(options());

    expect(result.outcome).toEqual({ kind: "ok" });
    expect(result.exitCode).toBe(0);
    expect(result.costUsd).toBe(0.0421);
    expect(result.inputTokens).toBe(320);
    expect(result.outputTokens).toBe(120);
    expect(result.resultText).toBe("Wrote the output file.");
    expect(existsSync(result.logPath)).toBe(true);
    expect(readFileSync(result.logPath, "utf8")).toContain(result.sessionId);

    const [call] = fake.calls();
    expect(call!.hasApiKey).toBe(false);
    expect(call!.stdin).toContain("Do the thing.");
    expect(call!.argv).toContain(result.sessionId);

    const [record] = store.listAgentRuns(run.id);
    expect(record).toMatchObject({ status: "ok", cost_usd: 0.0421, session_id: result.sessionId, pid: null });
    expect(record!.excerpt).toContain("Read: /repo/README.md");
    expect(seen.map((e) => e.type)).toEqual(["agent:start", "agent:activity", "agent:activity", "agent:end"]);
  });

  it("reports hitting max turns as an error", async () => {
    const { runner, options, store, run } = setup([{ stream: "error_max_turns" }]);
    const result = await runner(options());
    expect(result.outcome).toMatchObject({ kind: "error", subtype: "error_max_turns" });
    expect(result.costUsd).toBe(1.25);
    expect(store.listAgentRuns(run.id)[0]!.status).toBe("error");
  });

  it("reports a usage-limit rejection with its reset time", async () => {
    const { runner, options, store, run } = setup([{ stream: "rate_limited" }]);
    const result = await runner(options());
    expect(result.outcome).toEqual({ kind: "rate_limited", resetsAt: new Date(1893456000 * 1000).toISOString() });
    expect(store.listAgentRuns(run.id)[0]!.status).toBe("rate_limited");
  });

  it("reports a crash without a result", async () => {
    const { runner, options } = setup([]);
    const result = await runner(options());
    expect(result.outcome).toMatchObject({ kind: "error", subtype: "no_result" });
    expect(result.outcome.kind === "error" && result.outcome.message).toContain("no scripted step");
  });

  it("resumes the given session", async () => {
    const { runner, options, fake } = setup([{ stream: "success" }]);
    const result = await runner(options({ resumeSessionId: "existing-session" }));
    expect(result.sessionId).toBe("existing-session");
    expect(fake.calls()[0]!.argv).toEqual(expect.arrayContaining(["--resume", "existing-session"]));
  });

  it("kills an agent that runs past its timeout", async () => {
    const { runner, options } = setup([{ sleepMs: 30_000 }]);
    const started = Date.now();
    const result = await runner(options({ timeoutMs: 500 }));
    expect(result.outcome).toMatchObject({ kind: "error", subtype: "timeout" });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("stops when cancelled", async () => {
    const { runner, options, store, run } = setup([{ sleepMs: 30_000 }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runner(options({ signal: controller.signal }));
    expect(result.outcome).toMatchObject({ kind: "error", subtype: "cancelled" });
    expect(store.listAgentRuns(run.id)[0]!.status).toBe("cancelled");
  });
});
