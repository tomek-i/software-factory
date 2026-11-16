import type { FactoryEvent, SchedulerEvent } from "@factory/core";
import type { DraftResult } from "./drafts.js";

/** What the browser hears on `/api/events`. */
export type HubEvent =
  | SchedulerEvent
  | { type: "changed"; project?: string }
  /** Progress of an issue writer the New issue screen started. */
  | { type: "draft"; project: string; draftId: string; event: FactoryEvent }
  /** How it ended. */
  | { type: "draft:done"; project: string; draftId: string; result: DraftResult };

export interface Published {
  id: number;
  event: HubEvent;
}

/**
 * Fans the scheduler's events, the issue writers' progress, and "something changed" after an
 * action, out to every open event stream. Only this process's events: runs other processes drive
 * show up on the next fetch (#133).
 */
export class EventHub {
  private readonly listeners = new Set<(published: Published) => void>();
  private nextId = 1;

  publish(event: HubEvent): void {
    const published = { id: this.nextId++, event };
    for (const listener of this.listeners) listener(published);
  }

  subscribe(listener: (published: Published) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get size(): number {
    return this.listeners.size;
  }
}
