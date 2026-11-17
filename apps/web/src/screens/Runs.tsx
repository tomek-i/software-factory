import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { CleanupRuns } from "../components/Cleanup";
import { StateBadge } from "../components/StateBadge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { api, type RunView } from "../lib/api";
import { useLive } from "../lib/events";
import { useProject } from "../lib/project";
import { ago, cn, money, rounds } from "../lib/utils";
import { runPath } from "./RunDetail";

export function Runs() {
  const { project } = useProject();
  const [view, setView] = useState<Extract<RunView, "active" | "all">>("active");
  const { activity } = useLive();
  const runs = useQuery({ queryKey: ["runs", view, project], queryFn: () => api.runs(view, project), refetchInterval: 30_000 });

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Runs</h1>
        <div className="ml-auto flex gap-1" role="group" aria-label="Which runs">
          {(["active", "all"] as const).map((v) => (
            <Button key={v} size="sm" variant={view === v ? "secondary" : "ghost"} aria-pressed={view === v} onClick={() => setView(v)}>
              {v === "active" ? "Going on" : "All"}
            </Button>
          ))}
        </div>
      </div>
      {view === "all" && <CleanupRuns project={project} />}
      {runs.error && <p className="text-sm text-destructive">{runs.error.message}</p>}
      {runs.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">{view === "active" ? "No runs going on. Queue issues in the Backlog." : "No runs yet."}</p>
      )}
      {runs.data && runs.data.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>State</TableHead>
                <TableHead>Issue</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Round</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.data.map((run) => {
                const line = activity[run.id] ?? run.reason;
                return (
                  <TableRow key={`${run.project}/${run.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <StateBadge state={run.state} />
                        {run.held && <span className="size-2 animate-pulse rounded-full bg-sky-500" title="A worker is driving it" aria-label="working" />}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md xl:max-w-xl 2xl:max-w-3xl">
                      <Link to={runPath(run)} className="block truncate hover:underline">
                        {run.issue !== null && <span className="mr-1.5 font-mono text-muted-foreground">#{run.issue}</span>}
                        {run.title}
                      </Link>
                      {line && <div className={cn("truncate text-xs text-muted-foreground", activity[run.id] && "text-sky-700 dark:text-sky-300")}>{line}</div>}
                      <div className="font-mono text-xs text-muted-foreground">{run.id}</div>
                    </TableCell>
                    <TableCell>{run.projectName}</TableCell>
                    <TableCell className="font-mono text-xs">{rounds(run)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{money(run.cost)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={run.updatedAt}>
                      {ago(run.updatedAt)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}
