import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { DraftDetail, ServerEvent } from "./api";
import { sessionToken, TOKEN_HEADER } from "./session";

type RunEvent = Extract<ServerEvent, { type: "run" }>["event"] & { name?: string; passed?: boolean };

/** A run's progress as one line, the way `factory run` prints it, or undefined for one not worth showing. */
export function activityLine(event: RunEvent): string | undefined {
  switch (event.type) {
    case "agent:activity":
      return event.summary;
    case "agent:start":
      return `${event.role} started`;
    case "run:state":
      return `→ ${event.to}: ${event.reason}`;
    case "gate:check":
      return `check ${event.name} ${event.passed ? "passed" : "failed"}`;
    case "info":
      return event.message;
    default:
      return undefined;
  }
}

const RECONNECT_MS = 3_000;

/**
 * Reads `/api/events` with fetch rather than EventSource, which can't send the session header.
 * Reconnects until stopped; returns the stop.
 */
export function streamEvents(handlers: { onOpen(): void; onClose(): void; onEvent(event: ServerEvent): void }): () => void {
  let stopped = false;
  let abort = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = async () => {
    abort = new AbortController();
    try {
      const res = await fetch("/api/events", { headers: { [TOKEN_HEADER]: sessionToken() ?? "" }, signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`${res.status}`);
      handlers.onOpen();
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        // Messages end with a blank line; comments (heartbeats) start with ":".
        let end: number;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = message
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (data) handlers.onEvent(JSON.parse(data) as ServerEvent);
        }
      }
    } catch {
      // Closed, refused or cut off: the same as the stream ending.
    }
    if (stopped) return;
    handlers.onClose();
    retry = setTimeout(() => void connect(), RECONNECT_MS);
  };
  void connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    abort.abort();
  };
}

interface Live {
  /** The latest activity line per run id, from this page's stream. */
  activity: Record<string, string>;
  connected: boolean;
}

const LiveContext = createContext<Live>({ activity: {}, connected: false });

export const useLive = () => useContext(LiveContext);

/**
 * One event stream for the page. Anything that moves a run or the queue refetches what is on
 * screen; agent progress feeds each run's activity line. Only the events of `factory serve`'s own
 * scheduler arrive here: a `factory run` in another terminal shows on the next refetch.
 */
export function EventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState<Live>({ activity: {}, connected: false });

  useEffect(
    () =>
      streamEvents({
        onOpen: () => {
          setLive((l) => ({ ...l, connected: true }));
          // Events may have been missed while it was away.
          void queryClient.invalidateQueries();
        },
        onClose: () => setLive((l) => ({ ...l, connected: false })),
        onEvent: (event) => {
          if (event.type === "run") {
            const line = activityLine(event.event);
            if (line) setLive((l) => ({ ...l, activity: { ...l.activity, [event.event.runId]: line } }));
            if (event.event.type === "run:state") void queryClient.invalidateQueries();
            return;
          }
          // An issue writer's progress goes onto its draft's page as it comes, without refetching anything.
          if (event.type === "draft") {
            queryClient.setQueryData<DraftDetail>(["draft", event.project, event.draftId], (detail) =>
              detail?.job ? { ...detail, job: { ...detail.job, events: [...detail.job.events, event.event] } } : detail,
            );
            return;
          }
          void queryClient.invalidateQueries();
        },
      }),
    [queryClient],
  );

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}
