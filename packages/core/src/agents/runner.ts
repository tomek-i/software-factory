import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
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
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...withoutVars(env, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "NoDefaultCurrentDirectoryInExePath"]),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    NoDefaultCurrentDirectoryInExePath: "1",
  };
}

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
    const child = execa(file, [...args, ...claudeArgs(options, sessionId)], {
      cwd: options.cwd,
      env: agentEnv(env),
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
    let stopped: "timeout" | "cancelled" | undefined;
    const stop = (why: "timeout" | "cancelled") => {
      if (stopped || child.pid === undefined) return;
      stopped = why;
      killTree(child.pid);
    };
    const timer = options.timeoutMs ? setTimeout(() => stop("timeout"), options.timeoutMs) : undefined;
    const onAbort = () => stop("cancelled");
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort);

    const summary = emptySummary();
    const log = createWriteStream(logPath, { flags: "a" });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      log.write(line + "\n");
      for (const activity of applyStreamLine(summary, line)) {
        deps.events?.emit({ type: "agent:activity", runId: options.runId, agentRunId, summary: activity });
      }
    });

    const closed = new Promise<void>((resolve) => lines.once("close", resolve));
    const finished = await child;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    await closed;
    await new Promise<void>((resolve) => log.end(resolve));

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
