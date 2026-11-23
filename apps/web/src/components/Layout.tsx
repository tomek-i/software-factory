import { useQuery } from "@tanstack/react-query";
import { Activity, Clock, Inbox, ListTodo, Settings, SquarePen } from "lucide-react";
import { useEffect } from "react";
import { NavLink, Outlet } from "react-router";
import { api, ApiError } from "../lib/api";
import { useLive } from "../lib/events";
import { useProject } from "../lib/project";
import { startLimitNote } from "../lib/start-limit";
import { cn } from "../lib/utils";
import { Select } from "./ui/input";

function SchedulerState() {
  const { data } = useQuery({ queryKey: ["scheduler"], queryFn: api.scheduler, refetchInterval: 15_000 });
  const { connected } = useLive();
  let text = "not working";
  if (data?.stopping) text = data.stopping === "now" ? "stopping now" : "stopping after these runs";
  else if (data?.pausedUntil) text = `usage limit: paused until ${new Date(data.pausedUntil).toLocaleTimeString()}`;
  else if (data) text = `${data.running.length} running`;
  // Beside the running count: the queue is held back even though the scheduler is working.
  const limit = startLimitNote(data?.limited ?? []);
  return (
    <span className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="flex items-center gap-2" title={connected ? "Live" : "Reconnecting to the event stream"}>
        <span className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")} aria-hidden />
        {text}
      </span>
      {limit && (
        <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400" title={limit.label} aria-label={limit.label}>
          <Clock aria-hidden className="size-3.5" />
          {limit.text}
        </span>
      )}
    </span>
  );
}

/**
 * The page column shared by the header row and the content, so their edges always line up. It keeps
 * the 1152px column below `2xl` and grows on large screens, up to a cap so lines never span an ultrawide.
 */
const column = "mx-auto max-w-6xl px-4 xl:px-6 2xl:max-w-(--breakpoint-2xl) 2xl:px-8 min-[120rem]:max-w-[1800px]";

const tab = ({ isActive }: { isActive: boolean }) =>
  cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium [&_svg]:size-4", isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground");

export function Layout() {
  const { project, setProject } = useProject();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const waiting = useQuery({ queryKey: ["runs", "waiting", project], queryFn: () => api.runs("waiting", project) });
  // A remembered project that has since been removed from the list.
  const known = projects.data?.some((p) => p.key === project);
  useEffect(() => {
    if (project && projects.data && !known) setProject(undefined);
  }, [project, projects.data, known, setProject]);
  const inbox = waiting.data?.filter((r) => r.state === "needs_human").length ?? 0;

  if (projects.error instanceof ApiError && projects.error.status === 401) {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold">No session</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Open the link <code className="font-mono">factory serve</code> printed in its terminal. A new <code className="font-mono">factory serve</code> prints a new one.
        </p>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className={cn(column, "flex flex-wrap items-center gap-x-6 gap-y-2 py-3")}>
          <span className="font-semibold">Software factory</span>
          <nav className="flex flex-wrap items-center gap-1" aria-label="Main">
            <NavLink to="/inbox" className={tab}>
              <Inbox aria-hidden />
              Inbox
              {inbox > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 text-xs leading-5 text-white" aria-label={`${inbox} waiting`}>
                  {inbox}
                </span>
              )}
            </NavLink>
            <NavLink to="/runs" className={tab}>
              <Activity aria-hidden />
              Runs
            </NavLink>
            <NavLink to="/backlog" className={tab}>
              <ListTodo aria-hidden />
              Backlog
            </NavLink>
            <NavLink to="/new" className={tab}>
              <SquarePen aria-hidden />
              New issue
            </NavLink>
            <NavLink to="/settings" className={tab}>
              <Settings aria-hidden />
              Settings
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <SchedulerState />
            <Select aria-label="Project" value={project ?? ""} onChange={(e) => setProject(e.target.value || undefined)}>
              <option value="">All projects</option>
              {projects.data?.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                  {p.status === "ok" ? "" : ` (${p.status.replace("_", " ")})`}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </header>
      <main className={cn(column, "py-6")}>
        <Outlet />
      </main>
    </div>
  );
}
