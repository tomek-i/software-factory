import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { OpenFeedback } from "../components/OpenFeedback";
import { RunActions } from "../components/RunActions";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { api, type DraftView, type MergeGateDetails, type RunRow } from "../lib/api";
import { useProject } from "../lib/project";
import { ago, cn, money } from "../lib/utils";
import { draftPath } from "./Draft";
import { runPath } from "./RunDetail";

const MERGE_WAIT = "waiting at merge gate: ";
const ROUTINE = "gate is set to human";

/**
 * The reason a merge card shows: without "gate is set to human", which only repeats the gate badge.
 * Reasons that say more (a hard rule, an untrusted author, the approver's) stay.
 */
export function mergeReason(reason: string | undefined): string | undefined {
  if (!reason?.startsWith(MERGE_WAIT)) return reason;
  const rest = reason
    .slice(MERGE_WAIT.length)
    .split("; ")
    .filter((r) => r.trim() !== ROUTINE);
  return rest.length ? `${MERGE_WAIT}${rest.join("; ")}` : undefined;
}

/** The link, when it is a web address; anything else (javascript:, data:, a bare word) is not linked. */
export function webLink(link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** A name, linked when its link is a web address. Text from GitHub: never markup. */
function MaybeLink({ name, link, className }: { name: string; link?: string | null; className?: string }) {
  const href = webLink(link);
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={cn("underline", className)}>
      {name}
    </a>
  ) : (
    <span className={className}>{name}</span>
  );
}

/** What a merge would merge: the PR and its size, the head's checks, the reviews, rounds and cost. */
function MergeDetails({ details, loading, error }: { details?: MergeGateDetails; loading: boolean; error: Error | null }) {
  if (loading) return <p className="text-sm text-muted-foreground">Reading the PR and its checks…</p>;
  if (error) return <p className="text-sm text-destructive">Could not load the merge details: {error.message}</p>;
  if (!details) return null;
  const { pr, checks, reviews } = details;
  const notes = reviews.reduce((sum, r) => sum + ("findings" in r ? r.findings : 0), 0);
  const blocking = reviews.reduce((sum, r) => sum + ("blocking" in r ? r.blocking : 0), 0);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm xl:max-w-3xl" aria-label="Merge details">
      <dt className="text-muted-foreground">PR</dt>
      <dd>
        {pr ? (
          <>
            <MaybeLink name={`PR #${pr.number}`} link={pr.url} className="font-medium" />
            {pr.additions !== undefined && (
              <span className="ml-2 font-mono text-xs">
                <span className="text-emerald-700 dark:text-emerald-400">+{pr.additions}</span> / <span className="text-red-700 dark:text-red-400">-{pr.deletions}</span>,{" "}
                {plural(pr.changedFiles ?? 0, "file")}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">no pull request</span>
        )}
      </dd>
      {pr && (
        <>
          <dt className="text-muted-foreground">Checks</dt>
          <dd>
            {details.githubError ? (
              <span className="text-destructive">Could not read GitHub: {details.githubError}</span>
            ) : !checks ? (
              <span className="text-muted-foreground">unknown</span>
            ) : checks.passed + checks.failed + checks.pending + checks.skipped === 0 ? (
              <span className="text-muted-foreground">none reported</span>
            ) : (
              <>
                {checks.passed} passed, <span className={checks.failed ? "font-medium text-destructive" : undefined}>{checks.failed} failed</span>, {checks.pending} pending
                {checks.skipped > 0 && `, ${checks.skipped} skipped`}
              </>
            )}
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">Reviews</dt>
      <dd>
        {reviews.length === 0 ? (
          <span className="text-muted-foreground">none</span>
        ) : (
          <>
            {reviews.map((r, i) => (
              <span key={r.path}>
                {i > 0 && ", "}
                {"problem" in r ? (
                  <span title={r.problem}>
                    {r.lens} <span className="text-destructive">unparsed</span>
                  </span>
                ) : (
                  <>
                    {r.lens} <span className={cn("font-mono text-xs", r.verdict !== "PASS" && "text-destructive")}>{r.verdict}</span>
                  </>
                )}
              </span>
            ))}
            <span className="text-muted-foreground">
              {" "}
              · {plural(notes, "review note")}
              {blocking > 0 && ` (${blocking} blocking)`}
            </span>
          </>
        )}
      </dd>
      <dd className="col-span-2 text-xs text-muted-foreground">
        build round {details.rounds.build} · review round {details.rounds.review} · {money(details.cost)}
      </dd>
    </dl>
  );
}

/** The failed checks, above Approve: what "Approve anyway" would merge over. */
function FailedChecks({ checks }: { checks: { name: string; link?: string }[] }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm" role="note" aria-label="Failed checks">
      <p className="font-medium text-destructive">{checks.length === 1 ? "A check failed on this PR:" : `${checks.length} checks failed on this PR:`}</p>
      <ul className="ml-4 list-disc">
        {checks.map((c, i) => (
          <li key={`${c.name}-${i}`} className="text-destructive">
            <MaybeLink name={c.name} link={c.link} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One run waiting for a decision, with its actions inline and its details a click away. */
function Waiting({ run }: { run: RunRow }) {
  const merge = run.waitingGate === "merge";
  // Keyed on updatedAt too, so a run that moved and came back reads GitHub afresh.
  const details = useQuery({ queryKey: ["merge-gate", run.project, run.id, run.updatedAt], queryFn: () => api.mergeGate(run), enabled: merge });
  const failed = merge ? (details.data?.checks?.failedChecks ?? []) : [];
  const reason = merge ? mergeReason(run.reason) : run.reason;
  return (
    <Card>
      <CardHeader>
        <Badge className="bg-amber-500/15 font-mono text-amber-700 dark:text-amber-300">{run.waitingGate ? `${run.waitingGate} gate` : "escalation"}</Badge>
        <Link to={runPath(run)} className="font-medium underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-current">
          {run.issue !== null && <span className="mr-1.5 font-mono text-muted-foreground">#{run.issue}</span>}
          {run.title}
        </Link>
        <span className="ml-auto text-xs text-muted-foreground" title={run.updatedAt}>
          {run.projectName} · {ago(run.updatedAt)}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {reason && <p className="text-sm xl:max-w-3xl">{reason}</p>}
        {merge && <MergeDetails details={details.data} loading={details.isPending} error={details.error} />}
        <OpenFeedback run={run} />
        <p className="text-xs text-muted-foreground">
          <Link to={runPath(run)} className="underline">
            Details
          </Link>
          : triage, spec, build, reviews and the run's files.
        </p>
        {/* The reject/resume form keeps a readable width on wide screens; the card header does not. */}
        <div className="space-y-2 xl:max-w-3xl">
          {failed.length > 0 && <FailedChecks checks={failed} />}
          <RunActions run={run} warn={failed.length > 0} />
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
                <Link to={runPath(run)} className="underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-current">
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
