import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { RunActions } from "../components/RunActions";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { api, type DraftView, type RunRow } from "../lib/api";
import { useProject } from "../lib/project";
import { ago } from "../lib/utils";
import { draftPath } from "./Draft";
import { runPath } from "./RunDetail";

/** One run waiting for a decision, with its actions inline and its details a click away. */
function Waiting({ run }: { run: RunRow }) {
  return (
    <Card>
      <CardHeader>
        <Badge className="bg-amber-500/15 font-mono text-amber-700 dark:text-amber-300">{run.waitingGate ? `${run.waitingGate} gate` : "escalation"}</Badge>
        <Link to={runPath(run)} className="font-medium hover:underline">
          {run.issue !== null && <span className="mr-1.5 font-mono text-muted-foreground">#{run.issue}</span>}
          {run.title}
        </Link>
        <span className="ml-auto text-xs text-muted-foreground" title={run.updatedAt}>
          {run.projectName} · {ago(run.updatedAt)}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {run.reason && <p className="text-sm xl:max-w-3xl">{run.reason}</p>}
        <p className="text-xs text-muted-foreground">
          <Link to={runPath(run)} className="underline">
            Details
          </Link>
          : triage, spec, build, reviews and the run's files.
        </p>
        {/* The reject/resume form keeps a readable width on wide screens; the card header does not. */}
        <div className="xl:max-w-3xl">
          <RunActions run={run} />
        </div>
      </CardContent>
    </Card>
  );
}

/** Where a pending draft stands, in a word. */
function draftState(draft: DraftView): string {
  if (draft.running) return "being written";
  if (draft.refusal) return "refused: tracked by git";
  if (!draft.draft) return "does not parse";
  if (draft.draft.decision === "ESCALATE") return "escalated";
  return "waiting for you";
}

/** Drafts from the issue writer not created on GitHub yet, each opening its editor. */
function PendingDrafts({ drafts }: { drafts: DraftView[] }) {
  return (
    <div className="space-y-2 pt-4">
      <h2 className="text-sm font-medium text-muted-foreground">Pending drafts</h2>
      <ul className="space-y-1 text-sm" aria-label="Pending drafts">
        {drafts.map((d) => (
          <li key={`${d.project}/${d.id}`}>
            <Link to={draftPath(d.project, d.id)} className="hover:underline">
              {d.draft?.issue.title ?? (d.idea || d.id)}
            </Link>
            {d.draft && d.draft.subIssues.length > 0 && <span className="ml-1.5 text-xs text-muted-foreground">+{d.draft.subIssues.length} sub-issues</span>}{" "}
            <span className="text-xs text-muted-foreground" title={d.createdAt}>
              · {draftState(d)} · {d.projectName} · {ago(d.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Inbox() {
  const { project } = useProject();
  const runs = useQuery({ queryKey: ["runs", "waiting", project], queryFn: () => api.runs("waiting", project) });
  const drafts = useQuery({ queryKey: ["drafts", project], queryFn: () => api.drafts(project) });
  const human = runs.data?.filter((r) => r.state === "needs_human") ?? [];
  const author = runs.data?.filter((r) => r.state === "needs_info") ?? [];

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Inbox</h1>
      {runs.error && <p className="text-sm text-destructive">{runs.error.message}</p>}
      {runs.data && human.length === 0 && <p className="text-sm text-muted-foreground">Nothing waits for you.</p>}
      <div className="space-y-3">
        {human.map((run) => (
          <Waiting key={`${run.project}/${run.id}`} run={run} />
        ))}
      </div>
      {author.length > 0 && (
        <div className="space-y-2 pt-4">
          <h2 className="text-sm font-medium text-muted-foreground">Waiting for the issue's author</h2>
          <ul className="space-y-1 text-sm">
            {author.map((run) => (
              <li key={`${run.project}/${run.id}`}>
                <Link to={runPath(run)} className="hover:underline">
                  {run.issue !== null && <span className="mr-1.5 font-mono text-muted-foreground">#{run.issue}</span>}
                  {run.title}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">· {run.projectName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {drafts.error && <p className="text-sm text-destructive">{drafts.error.message}</p>}
      {drafts.data && drafts.data.length > 0 && <PendingDrafts drafts={drafts.data} />}
    </section>
  );
}
