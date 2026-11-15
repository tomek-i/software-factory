import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import { StateBadge } from "../components/StateBadge";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { api, type BacklogIssue, type ProjectInfo } from "../lib/api";
import { useProject } from "../lib/project";
import { ago } from "../lib/utils";

function QueueButton({ project, issue }: { project: string; issue: BacklogIssue }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api.queue(project, issue.number, !issue.queued),
    onSettled: () => queryClient.invalidateQueries(),
  });
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant={issue.queued ? "outline" : "secondary"} disabled={toggle.isPending} onClick={() => toggle.mutate()}>
        {issue.queued ? "Unqueue" : "Queue"}
      </Button>
      {toggle.error && (
        <span className="text-xs text-destructive" role="alert">
          {toggle.error.message}
        </span>
      )}
    </div>
  );
}

function ProjectBacklog({ project }: { project: ProjectInfo }) {
  const queryClient = useQueryClient();
  const backlog = useQuery({ queryKey: ["backlog", project.key], queryFn: () => api.backlog(project.key) });
  const sync = useMutation({ mutationFn: () => api.sync(project.key), onSuccess: () => queryClient.invalidateQueries() });

  return (
    <section className="space-y-3" aria-label={project.name}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{project.name}</h2>
        {backlog.data?.github && <span className="font-mono text-xs text-muted-foreground">{backlog.data.github}</span>}
        <span className="ml-auto text-xs text-muted-foreground">
          {sync.data
            ? `Synced: ${sync.data.open} open, ${sync.data.closed} closed since last sync, ${sync.data.queued} queued.`
            : backlog.data?.syncedAt
              ? `Synced ${ago(backlog.data.syncedAt)}`
              : "Never synced"}
        </span>
        <Button size="sm" variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
          <RefreshCw aria-hidden className={sync.isPending ? "animate-spin" : undefined} /> Sync now
        </Button>
      </div>
      {sync.error && (
        <p className="text-sm text-destructive" role="alert">
          {sync.error.message}
        </p>
      )}
      {backlog.error && <p className="text-sm text-destructive">{backlog.error.message}</p>}
      {backlog.data?.issues.length === 0 && <p className="text-sm text-muted-foreground">No open issues synced. Sync to pull them from GitHub.</p>}
      {backlog.data && backlog.data.issues.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Issue</TableHead>
                <TableHead>Author</TableHead>
                <TableHead>Latest run</TableHead>
                <TableHead className="text-right">Queue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backlog.data.issues.map((issue) => (
                <TableRow key={issue.number}>
                  <TableCell className="max-w-lg">
                    <div className="flex items-center gap-1.5">
                      <a href={issue.url} target="_blank" rel="noreferrer" className="font-mono text-muted-foreground hover:underline">
                        #{issue.number}
                      </a>
                      <span className="truncate">{issue.title}</span>
                      <ExternalLink aria-hidden className="size-3 shrink-0 text-muted-foreground" />
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    @{issue.author}
                    {!issue.trusted && (
                      <Badge className="ml-1.5 bg-amber-500/15 text-amber-700 dark:text-amber-300" title="Not in trust.authors: triage waits for your approval">
                        untrusted
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{issue.run ? <StateBadge state={issue.run.state} /> : <span className="text-xs text-muted-foreground">none</span>}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-2">
                      {issue.position !== null && (
                        <span className="font-mono text-xs text-muted-foreground" title="Place in the queue">
                          Q{issue.position}
                        </span>
                      )}
                      <QueueButton project={project.key} issue={issue} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </section>
  );
}

export function Backlog() {
  const { project } = useProject();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const shown = projects.data?.filter((p) => (project ? p.key === project : true)) ?? [];

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-semibold">Backlog</h1>
      {projects.error && <p className="text-sm text-destructive">{projects.error.message}</p>}
      {shown.map((p) =>
        p.status === "ok" ? (
          <ProjectBacklog key={p.key} project={p} />
        ) : (
          <section key={p.key} className="space-y-1">
            <h2 className="text-lg font-semibold">{p.name}</h2>
            <p className="text-sm text-destructive">{p.problem ?? `Can't open it: ${p.status.replace("_", " ")}.`}</p>
          </section>
        ),
      )}
    </div>
  );
}
