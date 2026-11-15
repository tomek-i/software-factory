import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ServerEvent } from "./api";

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

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setLive((l) => ({ ...l, connected: true }));
    // EventSource reconnects on its own; refetch on the way back, as events may have been missed.
    source.onerror = () => setLive((l) => ({ ...l, connected: false }));
    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as ServerEvent;
      if (event.type === "run") {
        const line = activityLine(event.event);
        if (line) setLive((l) => ({ ...l, activity: { ...l.activity, [event.event.runId]: line } }));
        if (event.event.type === "run:state") void queryClient.invalidateQueries();
        return;
      }
      void queryClient.invalidateQueries();
    };
    return () => source.close();
  }, [queryClient]);

  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}
