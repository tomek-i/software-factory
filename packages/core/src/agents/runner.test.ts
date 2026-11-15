import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeClaude, GIT_TEST_TIMEOUT, tempDir, type FakeStep } from "../../test/helpers.js";
import { FactoryEvents, type FactoryEvent } from "../events.js";
import { CHECK_ENV_DENYLIST } from "../gate/gate.js";
import { Store } from "../store/store.js";
import { runCommand } from "../util/exec.js";
import { AGENT_ENV_DENYLIST, agentEnv, claudeArgs, claudeCommand, createAgentRunner, withoutVars, type AgentRunOptions } from "./runner.js";

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
  /** What every agent environment adds: no auto-memory, no cwd lookup, no git credentials or prompts. */
  const added = {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    NoDefaultCurrentDirectoryInExePath: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };

  it("removes ANTHROPIC_API_KEY in any casing so runs use the subscription", () => {
    const env = agentEnv({ ANTHROPIC_API_KEY: "sk-ant-x", anthropic_api_key: "y", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin", ...added });
  });

  it("switches auto-memory off even if the caller's env tried to enable it", () => {
    const env = agentEnv({ claude_code_disable_auto_memory: "0", PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin", ...added });
  });

  it("removes GitHub tokens and other ways to a login, and points gh at the folder it is given", () => {
    const env = agentEnv(
      {
        PATH: "/bin",
        GH_TOKEN: "a",
        github_token: "b",
        GH_ENTERPRISE_TOKEN: "c",
        GITHUB_ENTERPRISE_TOKEN: "d",
        GIT_ASKPASS: "/x/askpass",
        SSH_ASKPASS: "/x/ssh-askpass",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        GH_CONFIG_DIR: "/home/me/.config/gh",
        GIT_TERMINAL_PROMPT: "1",
      },
      { ghConfigDir: "/tmp/empty" },
    );
    expect(env).toEqual({ PATH: "/bin", GH_CONFIG_DIR: "/tmp/empty", ...added });
  });

  it("replaces config the caller passes through GIT_CONFIG_*, which could set a credential helper back", () => {
    const env = agentEnv({ PATH: "/bin", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c", git_config_key_1: "credential.helper", GIT_CONFIG_VALUE_1: "manager" });
    expect(env).toEqual({ PATH: "/bin", ...added });
  });

  it("keeps every token the checks never get", () => {
    expect(AGENT_ENV_DENYLIST).toEqual(expect.arrayContaining(CHECK_ENV_DENYLIST));
  });

  // The real tools, so a change in how gh or git find a login fails here and not in a run.
  const ghInstalled = runCommand("gh", ["--version"], { cwd: process.cwd() }).code === 0;

  // `gh auth token` still reads a keyring login directly; only the builder's `Bash(gh:*)` deny rule stands in its way.
  it.skipIf(!ghInstalled)("leaves gh's GitHub calls unauthenticated, whatever login the user has", () => {
    const empty = tempDir("factory-gh-test-");
    // Refused before any request is sent (exit 4: not logged in), so this needs no network.
    const result = spawnSync("gh", ["api", "user"], { cwd: empty, env: agentEnv(process.env, { ghConfigDir: empty }), encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("gh auth login");
  });

  it("gives git no credential helper and no prompt, so a push from an agent's shell has no login", () => {
    const result = spawnSync("git", ["credential", "fill"], {
      cwd: tempDir("factory-git-test-"),
      env: agentEnv(process.env),
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout.includes("password=")).toBe(false);
  }, GIT_TEST_TIMEOUT);
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
  it.runIf(process.platform === "win32")("never runs a claude.cmd planted in the agent's working directory", async () => {
    const { options, dir } = setup([]);
    const bin = tempDir();
    const marker = join(tempDir(), "which.txt");
    writeFileSync(join(bin, "claude.cmd"), `@echo path>"${marker}"\r\n`);
    writeFileSync(join(dir, "claude.cmd"), `@echo planted>"${marker}"\r\n`);
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    // Shells such as Claude Code's set this already; a plain terminal does not, so test without it.
    const outer = withoutVars(process.env, ["NoDefaultCurrentDirectoryInExePath"]);
    const saved = process.env;
    process.env = outer;
    try {
      const planted = createAgentRunner({
        env: { ...outer, FACTORY_CLAUDE_BIN: "", [pathKey]: `${bin};${outer[pathKey] ?? ""}` },
      });
      await planted(options());
    } finally {
      process.env = saved;
    }

    expect(readFileSync(marker, "utf8").trim()).toBe("path");
  });

  it("returns session, cost, tokens and log path, and records the agent run", async () => {
    const { runner, options, store, run, fake, seen } = setup([{ stream: "success", output: "DECISION: APPROVE\n" }], {
      ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
      GH_TOKEN: "ghp_must-not-leak",
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
    expect(call!.hasGithubToken).toBe(false);
    // gh gets an empty config folder of its own while the agent runs, removed afterwards.
    expect(call!.ghConfigEntries).toBe(0);
    expect(existsSync(call!.ghConfigDir!)).toBe(false);
    expect(call!.stdin).toContain("Do the thing.");
    expect(call!.argv).toContain(result.sessionId);

    const [record] = store.listAgentRuns(run.id);
    expect(record).toMatchObject({ status: "ok", cost_usd: 0.0421, session_id: result.sessionId, pid: null });
    expect(record!.excerpt).toContain("Read: /repo/README.md");
    expect(seen.map((e) => e.type)).toEqual(["agent:start", "agent:activity", "agent:activity", "agent:end"]);
  });

  it("runs without a store for agents that have no run yet, still logging the stream", async () => {
    const { options, fake } = setup([{ stream: "success" }]);
    const seen: FactoryEvent[] = [];
    const events = new FactoryEvents();
    events.on((e) => seen.push(e));
    const runner = createAgentRunner({ events, env: fake.env });

    const result = await runner(options({ runId: "draft-1" }));

    expect(result.outcome).toEqual({ kind: "ok" });
    expect(result.agentRunId).toMatch(/^agent-/);
    expect(readFileSync(result.logPath, "utf8")).toContain(result.sessionId);
    expect(seen.at(-1)).toMatchObject({ type: "agent:end", runId: "draft-1", agentRunId: result.agentRunId, status: "ok" });
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
