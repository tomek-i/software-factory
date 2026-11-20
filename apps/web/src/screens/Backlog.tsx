import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Clock, ExternalLink, RefreshCw } from "lucide-react";
import { StateBadge } from "../components/StateBadge";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Select } from "../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { api, type BacklogIssue, type ProjectInfo, type StartLimit } from "../lib/api";
import { useProject } from "../lib/project";
import { ago } from "../lib/utils";
import { githubUrl } from "./RunDetail";

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

/** The distinct labels across the issues, sorted alphabetically regardless of case. */
export function distinctLabels(issues: BacklogIssue[]): string[] {
  return [...new Set(issues.flatMap((issue) => issue.labels))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The backlog table, showing only the issues carrying `label` when one is set. */
export function BacklogTable({ project, issues, label }: { project: string; issues: BacklogIssue[]; label: string }) {
  const shown = label ? issues.filter((issue) => issue.labels.includes(label)) : issues;
  if (shown.length === 0) return <p className="text-sm text-muted-foreground">No open issues with label {label}.</p>;
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Issue</TableHead>
            <TableHead>Author</TableHead>
            <TableHead>Labels</TableHead>
            <TableHead>Latest run</TableHead>
            <TableHead className="text-right">Queue</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((issue) => (
            <TableRow key={issue.number}>
              <TableCell className="max-w-lg xl:max-w-xl 2xl:max-w-3xl">
                <div className="flex items-center gap-1.5">
                  {/* Only a GitHub link: an issue `factory import` added has no url until it is synced. */}
                  <a href={githubUrl(issue.url)} target="_blank" rel="noreferrer" className="font-mono text-muted-foreground hover:underline">
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
              <TableCell>
                {issue.labels.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {issue.labels.map((name) => (
                      <Badge key={name} className="border bg-muted text-muted-foreground">
                        {name}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">none</span>
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
                  <QueueButton project={project} issue={issue} />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

/** Why queued issues are not starting, worded as `factory status` words it. */
export function startLimitText(limit: StartLimit, now = new Date()): string {
  if (limit.max === 0) return "Start limit: github.max_starts_per_day is 0, so no queued issue starts until it is raised.";
  const runs = `${limit.started} run${limit.started === 1 ? "" : "s"}`;
  let next = "";
  if (limit.nextStartAt) {
    const at = new Date(limit.nextStartAt);
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    next = ` The next queued issue can start at ${at.toDateString() === now.toDateString() ? time : `${time} on ${at.toLocaleDateString()}`}.`;
  }
  return `Start limit reached: ${runs} started in the last 24 h (github.max_starts_per_day).${next}`;
}

function ProjectBacklog({ project }: { project: ProjectInfo }) {
  const queryClient = useQueryClient();
  const backlog = useQuery({ queryKey: ["backlog", project.key], queryFn: () => api.backlog(project.key) });
  const sync = useMutation({ mutationFn: () => api.sync(project.key), onSuccess: () => queryClient.invalidateQueries() });
  const [selected, setSelected] = useState("");
  const labels = distinctLabels(backlog.data?.issues ?? []);
  // A label that no open issue carries any more (after a sync) falls back to all labels.
  const label = labels.includes(selected) ? selected : "";

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
        {labels.length > 0 && (
          <Select aria-label="Filter by label" className="h-8 text-xs" value={label} onChange={(e) => setSelected(e.target.value)}>
            <option value="">All labels</option>
            {labels.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        )}
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
      {backlog.data?.startLimit && (
        <p role="status" className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
          <Clock aria-hidden className="mt-0.5 size-4 shrink-0" />
          {startLimitText(backlog.data.startLimit)}
        </p>
      )}
      {backlog.data?.issues.length === 0 && <p className="text-sm text-muted-foreground">No open issues synced. Sync to pull them from GitHub.</p>}
      {backlog.data && backlog.data.issues.length > 0 && <BacklogTable project={project.key} issues={backlog.data.issues} label={label} />}
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
