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
  if (!leftover && !clean.data && !clean.error) return null;
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
        {clean.error && (
          <p role="alert" className="text-sm text-destructive">
            {clean.error.message}
          </p>
        )}
        <div role="status" aria-label="Cleanup result" className="text-sm">
          {clean.data && <Outcome result={{ lines: clean.data.lines, skipped: [] }} />}
        </div>
      </CardContent>
    </Card>
  );
}

/** One project's cleanup: what it did, or why it failed. */
interface ProjectCleanup {
  name: string;
  result?: CleanupResult;
  error?: string;
}

/**
 * `factory cleanup` for the projects in view: removes the worktrees and branches of finished runs,
 * keeps work that would be lost, and lists the runs it left alone (just finished, or still held by a
 * worker). `now` skips the 2-minute wait after a run finished. Keyed by the project in view, so an
 * outcome never carries over to another one.
 */
export function CleanupRuns({ project }: { project?: string }) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const clean = useMutation({
    mutationFn: async (now: boolean): Promise<ProjectCleanup[]> => {
      const all = projects.data ?? [];
      const targets = project ? all.filter((p) => p.key === project) : all.filter((p) => p.status === "ok");
      const done: ProjectCleanup[] = [];
      // One project at a time, each reported on its own: a failure in one keeps what the others did.
      for (const p of targets) {
        try {
          done.push({ name: p.name, result: await api.cleanup(p.key, now) });
        } catch (err) {
          done.push({ name: p.name, error: (err as Error).message });
        }
      }
      return done;
    },
    onSettled: () => queryClient.invalidateQueries(),
  });
  const recent = clean.data?.some((p) => p.result?.skipped.some((s) => s.recent));
  const several = (clean.data?.length ?? 0) > 1;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={clean.isPending || !projects.data} onClick={() => clean.mutate(false)}>
          <Trash2 aria-hidden /> Clean up finished runs
        </Button>
        {recent && (
          <Button size="sm" variant="ghost" disabled={clean.isPending} onClick={() => clean.mutate(true)}>
            Also clean up the runs that just finished
          </Button>
        )}
      </div>
      <div role="status" className="space-y-2 text-sm">
        {clean.data?.length === 0 && <p className="text-muted-foreground">No projects to clean up.</p>}
        {clean.data?.map((p) => (
          <div key={p.name} className="space-y-1">
            {several && <h3 className="font-medium">{p.name}</h3>}
            {p.result && <Outcome result={p.result} />}
            {p.error && (
              <p role="alert" className="text-destructive">
                {p.error}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Outcome({ result }: { result: CleanupResult }) {
  if (result.lines.length === 0 && result.skipped.length === 0) return <p className="text-muted-foreground">Nothing to clean up.</p>;
  return (
    <>
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
    </>
  );
}
