import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api, type CleanupResult, type RunDetail, type RunRow } from "../lib/api";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader } from "./ui/card";

/**
 * A finished run's worktree and branch that cleanup has not removed yet, with a button to remove them
 * now. The server keeps work that would be lost and says why, as the automatic cleanup does. After a
 * removal the card stays, with what was removed, until the page changes.
 */
export function Leftover({ run, leftover }: { run: RunRow; leftover?: RunDetail["leftover"] }) {
  const queryClient = useQueryClient();
  const clean = useMutation({ mutationFn: () => api.cleanupRun(run), onSuccess: () => queryClient.invalidateQueries() });
  if (!leftover && !clean.data) return null;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">Worktree and branch</h2>
      </CardHeader>
      <CardContent className="space-y-3">
        {leftover && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Worktree</dt>
              <dd className="break-all font-mono">{leftover.worktree}</dd>
              <dt className="text-muted-foreground">Branch</dt>
              <dd className="break-all font-mono">{leftover.branch}</dd>
            </dl>
            {leftover.kept && <p className="text-sm">Kept on purpose: {leftover.kept}</p>}
            <Button size="sm" variant="outline" disabled={clean.isPending} onClick={() => clean.mutate()}>
              <Trash2 aria-hidden /> Clean up
            </Button>
          </>
        )}
        {clean.error && <p className="text-sm text-destructive">{clean.error.message}</p>}
        {clean.data && <Outcome result={{ lines: clean.data.lines, skipped: [] }} />}
      </CardContent>
    </Card>
  );
}

/**
 * `factory cleanup` for the projects in view: removes the worktrees and branches of finished runs,
 * keeps work that would be lost, and lists the runs it left alone (just finished, or still held by a
 * worker). `now` skips the 2-minute wait after a run finished.
 */
export function CleanupRuns({ project }: { project?: string }) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects, enabled: !project });
  const clean = useMutation({
    mutationFn: async (now: boolean) => {
      const keys = project ? [project] : (projects.data ?? []).filter((p) => p.status === "ok").map((p) => p.key);
      const results: CleanupResult[] = [];
      // One project at a time: each removes worktrees in its own repo, and the output stays in order.
      for (const key of keys) results.push(await api.cleanup(key, now));
      return { lines: results.flatMap((r) => r.lines), skipped: results.flatMap((r) => r.skipped) };
    },
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={clean.isPending} onClick={() => clean.mutate(false)}>
          <Trash2 aria-hidden /> Clean up finished runs
        </Button>
        {clean.data?.skipped.some((s) => s.recent) && (
          <Button size="sm" variant="ghost" disabled={clean.isPending} onClick={() => clean.mutate(true)}>
            Also clean up the runs that just finished
          </Button>
        )}
      </div>
      {clean.error && <p className="text-sm text-destructive">{clean.error.message}</p>}
      {clean.data && <Outcome result={clean.data} />}
    </div>
  );
}

function Outcome({ result }: { result: CleanupResult }) {
  const empty = result.lines.length === 0 && result.skipped.length === 0;
  return (
    <div role="status" className="space-y-1 text-sm">
      {empty && <p className="text-muted-foreground">Nothing to clean up.</p>}
      {result.lines.length > 0 && (
        <ul className="space-y-0.5">
          {result.lines.map((line, i) => (
            <li key={i} className="break-words font-mono text-xs">
              {line}
            </li>
          ))}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <>
          <p className="text-muted-foreground">Left alone:</p>
          <ul className="space-y-0.5">
            {result.skipped.map((s) => (
              <li key={s.runId} className="break-words text-xs">
                <span className="font-mono">{s.runId}</span>: {s.why}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
