import { EventEmitter } from "node:events";
import type { RunState } from "@factory/shared";

/** Progress the engine reports while it works. The CLI prints these; the web UI will stream them. */
export type FactoryEvent =
  | { type: "run:state"; runId: string; from: RunState | null; to: RunState; reason: string }
  | { type: "agent:start"; runId: string; agentRunId: string; role: string; sessionId: string; resumed: boolean }
  | { type: "agent:activity"; runId: string; agentRunId: string; summary: string }
  | { type: "agent:end"; runId: string; agentRunId: string; role: string; status: string; costUsd: number | null }
  | { type: "gate:check"; runId: string; name: string; passed: boolean; durationMs: number }
  | { type: "info"; runId: string; message: string };

export class FactoryEvents {
  private readonly emitter = new EventEmitter();

  emit(event: FactoryEvent): void {
    this.emitter.emit("event", event);
  }

  /** Returns an unsubscribe function. */
  on(listener: (event: FactoryEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
