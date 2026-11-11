/**
 * Folds Claude Code's `--output-format stream-json` lines into a summary of the agent run.
 * Unknown event types are ignored so newer CLI versions don't break parsing.
 */

export interface StreamSummary {
  sessionId?: string;
  /** From the final `result` event. */
  result?: {
    subtype: string;
    isError: boolean;
    text: string;
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
    numTurns?: number;
  };
  /** Set when the subscription's usage limit rejected a request. */
  rateLimit?: { resetsAt?: string };
  /** Short human-readable lines describing what the agent did, for progress output. */
  activity: string[];
}

export const emptySummary = (): StreamSummary => ({ activity: [] });

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** `resetsAt` arrives as unix seconds (or occasionally an ISO string). */
function toIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function describeToolUse(block: Json): string | undefined {
  if (block.type !== "tool_use" || typeof block.name !== "string") return undefined;
  const input = isObject(block.input) ? block.input : {};
  const detail = input.command ?? input.file_path ?? input.pattern ?? input.path;
  const text = typeof detail === "string" ? detail.replace(/\s+/g, " ").slice(0, 120) : "";
  return text ? `${block.name}: ${text}` : String(block.name);
}

/** Apply one stream line to the summary. Returns activity lines produced by this line. */
export function applyStreamLine(summary: StreamSummary, line: string): string[] {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(event)) return [];

  if (typeof event.session_id === "string") summary.sessionId = event.session_id;

  const produced: string[] = [];
  switch (event.type) {
    case "assistant": {
      const message = isObject(event.message) ? event.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!isObject(block)) continue;
        const tool = describeToolUse(block);
        if (tool) produced.push(tool);
      }
      break;
    }
    case "rate_limit_event": {
      const info = isObject(event.rate_limit_info) ? event.rate_limit_info : event;
      if (info.status === "rejected") summary.rateLimit = { resetsAt: toIso(info.resetsAt) };
      break;
    }
    case "system": {
      if (event.subtype === "api_retry" && event.error === "rate_limit") {
        summary.rateLimit ??= { resetsAt: toIso(event.resetsAt) };
      }
      break;
    }
    case "result": {
      const usage = isObject(event.usage) ? event.usage : {};
      summary.result = {
        subtype: typeof event.subtype === "string" ? event.subtype : "unknown",
        isError: event.is_error === true,
        text: typeof event.result === "string" ? event.result : "",
        costUsd: num(event.total_cost_usd),
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        numTurns: num(event.num_turns),
      };
      break;
    }
  }
  summary.activity.push(...produced);
  // Only the tail is ever shown; don't let a long session grow this without bound.
  if (summary.activity.length > 200) summary.activity.splice(0, summary.activity.length - 200);
  return produced;
}
