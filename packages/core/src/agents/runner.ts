import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execa } from "execa";
import type { FactoryEvents } from "../events.js";
import type { Store } from "../store/store.js";
import { killTree } from "../util/process.js";
import { applyStreamLine, emptySummary, type StreamSummary } from "./stream.js";

export interface AgentRunOptions {
  runId: string;
  role: string;
  model: string;
  /** Claude Code `--effort`; unset leaves Claude Code's default. */
  effort?: string;
  /** The agent's working directory: the run's worktree, or the repo root for read-only roles. */
  cwd: string;
  /** User message, sent on stdin (avoids command-line length and quoting limits on Windows). */
  prompt: string;
  /** Role instructions, appended to Claude Code's system prompt. */
  systemPromptFile: string;
  /** Claude Code settings JSON with the role's permission profile. */
  settingsFile: string;
  /** Extra directories the agent may use besides cwd, e.g. the run folder. */
  addDirs?: string[];
  maxTurns?: number;
  /** Continue this session instead of starting a new one. */
  resumeSessionId?: string;
  /** Where the full stream-json log is written: <logDir>/<agent-run-id>.jsonl */
  logDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AgentOutcome =
  | { kind: "ok" }
  | { kind: "error"; subtype: string; message: string }
  | { kind: "rate_limited"; resetsAt?: string };

export interface AgentRunResult {
  agentRunId: string;
  sessionId: string;
  outcome: AgentOutcome;
  exitCode: number | undefined;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  logPath: string;
  /** The agent's final message. */
  resultText: string;
}

export type AgentRunner = (options: AgentRunOptions) => Promise<AgentRunResult>;

/**
 * The claude binary and any leading arguments. FACTORY_CLAUDE_BIN may point at a Node script
 * (the fake used in tests), which is then run with the current Node binary.
 */
export function claudeCommand(env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  const bin = env.FACTORY_CLAUDE_BIN?.trim();
  if (!bin) return { file: "claude", args: [] };
  return /\.(m?js|cjs)$/i.test(bin) ? { file: process.execPath, args: [bin] } : { file: bin, args: [] };
}

/**
 * Environment for the agent. ANTHROPIC_API_KEY always wins over the subscription login in
 * `claude -p`, so it is removed: runs must use the user's own Claude subscription.
 * Auto-memory is switched off: --setting-sources "" does not disable it, so agents reading untrusted
 * issue text could otherwise read the user's personal memory for the repo and write to it.
 * On Windows, commands are looked up in the current directory before PATH. The agent runs in a
 * worktree the builder writes to, so a planted claude.cmd would run with the user's environment;
 * NoDefaultCurrentDirectoryInExePath turns that lookup off, for execa and for the agent's own tools.
 * A relative entry in the user's PATH (such as `.`) is still resolved against the worktree.
 *
 * No GitHub credentials: the engine pushes, opens PRs and merges itself, so an agent steered by
 * issue text must not act as the user. `gh` keeps its login in the keyring or its config folder, not
 * in the environment, so removing the token variables is not enough: `ghConfigDir` (an empty
 * folder) leaves `gh`'s GitHub calls unauthenticated. git's credential helpers (Git Credential
 * Manager) and askpass program are cleared through GIT_CONFIG_COUNT, which outranks every config
 * file without touching them (GIT_CONFIG_PARAMETERS, read after it, is removed), nothing may prompt
 * for a login, and ssh may use no key file or agent. This is a barrier, not a sandbox: an agent with
 * a shell runs as the user, so it could still undo it on purpose, for example `git -c
 * credential.helper=manager push` or reading the OS keyring (`gh auth token` does exactly that,
 * which is why the builder's profile also denies `gh` outright).
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env, options: { ghConfigDir?: string } = {}): NodeJS.ProcessEnv {
  const configVars = Object.keys(env).filter((key) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i.test(key));
  return {
    ...withoutVars(env, [
      ...AGENT_ENV_DENYLIST,
      ...configVars,
      "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
      "NoDefaultCurrentDirectoryInExePath",
      "GH_CONFIG_DIR",
      "GIT_TERMINAL_PROMPT",
      "GCM_INTERACTIVE",
      "GIT_SSH_COMMAND",
    ]),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    NoDefaultCurrentDirectoryInExePath: "1",
    ...(options.ghConfigDir ? { GH_CONFIG_DIR: options.ghConfigDir } : {}),
    // An empty helper resets the list from every config file before it, URL-scoped ones included;
    // an empty askPass turns off the program git would otherwise ask once no helper answers.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.askPass",
    GIT_CONFIG_VALUE_1: "",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    // Overrides core.sshCommand: no key file, no agent, no prompt, so an ssh remote has no login either.
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=none -o IdentityAgent=none",
  };
}

/**
 * Variables an agent never gets: API billing, GitHub tokens (at least the checks' CHECK_ENV_DENYLIST,
 * which imports from here, so it is not reused) and ways to reach a login another way.
 */
export const AGENT_ENV_DENYLIST = [
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_PAT",
  "GITHUB_PAT",
  "GITHUB_API_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "GIT_SSH",
  "GIT_CONFIG_PARAMETERS",
];

/** Copy of env without the given variables, matched case-insensitively (Windows env is case-insensitive). */
export function withoutVars(env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const drop = new Set(names.map((n) => n.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !drop.has(key.toUpperCase())));
}

export function claudeArgs(options: AgentRunOptions, sessionId: string): string[] {
  // Never --bare: it ignores the subscription login.
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    "--append-system-prompt-file",
    options.systemPromptFile,
    "--settings",
    options.settingsFile,
    // Anything the role's profile does not allow is denied instead of waiting for a prompt nobody answers.
    "--permission-mode",
    "dontAsk",
    // --settings only adds a layer: without these, allow rules, hooks and MCP servers from the
    // user's and the repo's own settings would apply to agents that read untrusted issue text.
    // The subscription login is not a setting, so it still applies.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ];
  if (options.effort) args.push("--effort", options.effort);
  if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
  for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
  args.push(...(options.resumeSessionId ? ["--resume", sessionId] : ["--session-id", sessionId]));
  return args;
}

function outcomeOf(summary: StreamSummary, exitCode: number | undefined, stderr: string): AgentOutcome {
  const result = summary.result;
  if (result && !result.isError && result.subtype === "success") return { kind: "ok" };
  if (summary.rateLimit) return { kind: "rate_limited", resetsAt: summary.rateLimit.resetsAt };
  if (result) return { kind: "error", subtype: result.subtype, message: result.text || `agent ended with ${result.subtype}` };
  return {
    kind: "error",
    subtype: "no_result",
    message: `agent exited with code ${exitCode ?? "unknown"} without a result${stderr ? `: ${stderr.slice(-500)}` : ""}`,
  };
}

function excerptOf(summary: StreamSummary, outcome: AgentOutcome): string {
  const lines = [...summary.activity.slice(-10)];
  if (summary.result?.text) lines.push("", summary.result.text.slice(0, 2000));
  if (outcome.kind === "error") lines.push("", `error (${outcome.subtype}): ${outcome.message.slice(0, 500)}`);
  return lines.join("\n").trim();
}

/**
 * Spawn headless Claude Code for one agent turn and record it in agent_runs. Without a store nothing
 * is recorded: an issue draft (`factory new`) has no run yet for the record to belong to.
 */
export function createAgentRunner(deps: { store?: Store; events?: FactoryEvents; env?: NodeJS.ProcessEnv }): AgentRunner {
  return async (options) => {
    const env = deps.env ?? process.env;
    const sessionId = options.resumeSessionId ?? randomUUID();
    mkdirSync(options.logDir, { recursive: true });
    const record = deps.store?.startAgentRun({
      run_id: options.runId,
      role: options.role,
      model: options.model,
      effort: options.effort ?? null,
      session_id: sessionId,
      log_dir: options.logDir,
    });
    const agentRunId = record?.id ?? `agent-${randomUUID().slice(0, 8)}`;
    const logPath = record?.log_path ?? join(options.logDir, `${agentRunId}.jsonl`);
    deps.events?.emit({
      type: "agent:start",
      runId: options.runId,
      agentRunId,
      role: options.role,
      sessionId,
      resumed: !!options.resumeSessionId,
    });

    const { file, args } = claudeCommand(env);
    // An empty gh config folder per agent: `gh` finds no login there (see agentEnv). Removed on
    // every path out of the turn below.
    const ghConfigDir = mkdtempSync(join(tmpdir(), "factory-gh-"));
    let stopped: "timeout" | "cancelled" | undefined;
    const summary = emptySummary();
    let finished: Awaited<ReturnType<typeof execa>>;
    try {
      const child = execa(file, [...args, ...claudeArgs(options, sessionId)], {
        cwd: options.cwd,
        env: agentEnv(env, { ghConfigDir }),
        extendEnv: false,
        input: options.prompt,
        reject: false,
        windowsHide: true,
        buffer: { stdout: false, stderr: true },
        maxBuffer: { stderr: 1_000_000 },
      });
      if (record && child.pid !== undefined) deps.store?.setAgentPid(record.id, child.pid);

      // Timeouts and cancellation kill the whole tree while the parent is still alive; once it has
      // exited, its children can no longer be found from its pid.
      const stop = (why: "timeout" | "cancelled") => {
        if (stopped || child.pid === undefined) return;
        stopped = why;
        killTree(child.pid);
      };
      const timer = options.timeoutMs ? setTimeout(() => stop("timeout"), options.timeoutMs) : undefined;
      const onAbort = () => stop("cancelled");
      if (options.signal?.aborted) onAbort();
      options.signal?.addEventListener("abort", onAbort);

      const log = createWriteStream(logPath, { flags: "a" });
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        log.write(line + "\n");
        for (const activity of applyStreamLine(summary, line)) {
          deps.events?.emit({ type: "agent:activity", runId: options.runId, agentRunId, summary: activity });
        }
      });

      const closed = new Promise<void>((resolve) => lines.once("close", resolve));
      finished = await child;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      await closed;
      await new Promise<void>((resolve) => log.end(resolve));
    } finally {
      try {
        rmSync(ghConfigDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A leftover folder in the temp dir (Windows can hold it for a moment) is harmless and must not fail the turn.
      }
    }

    const stderr = typeof finished.stderr === "string" ? finished.stderr : "";
    let outcome = outcomeOf(summary, finished.exitCode, stderr);
    if (stopped === "timeout") outcome = { kind: "error", subtype: "timeout", message: `agent timed out after ${options.timeoutMs}ms` };
    if (stopped === "cancelled") outcome = { kind: "error", subtype: "cancelled", message: "agent was cancelled" };

    const result: AgentRunResult = {
      agentRunId,
      sessionId: summary.sessionId ?? sessionId,
      outcome,
      exitCode: finished.exitCode,
      costUsd: summary.result?.costUsd,
      inputTokens: summary.result?.inputTokens,
      outputTokens: summary.result?.outputTokens,
      logPath,
      resultText: summary.result?.text ?? "",
    };
    const status =
      outcome.kind === "ok" ? "ok" : outcome.kind === "rate_limited" ? "rate_limited" : stopped === "cancelled" ? "cancelled" : "error";
    if (record) deps.store?.finishAgentRun(record.id, {
      status,
      session_id: result.sessionId,
      cost_usd: result.costUsd,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      excerpt: excerptOf(summary, outcome),
    });
    deps.events?.emit({
      type: "agent:end",
      runId: options.runId,
      agentRunId,
      role: options.role,
      status,
      costUsd: result.costUsd ?? null,
    });
    return result;
  };
}
