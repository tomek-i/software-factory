import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { OpenFeedback } from "../components/OpenFeedback";
import { RunActions } from "../components/RunActions";
import { StateBadge } from "../components/StateBadge";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { api, type AcceptanceCriterion, type OverviewSection, type RunRow } from "../lib/api";
import { ago, money, rounds } from "../lib/utils";

/** Where a run's detail view lives: the Inbox and Runs screens link here. */
export const runPath = (run: Pick<RunRow, "project" | "id">) => `/runs/${encodeURIComponent(run.project)}/${encodeURIComponent(run.id)}`;

/** Only a GitHub page is linked; anything else in the store is shown as nothing. */
export const githubUrl = (url: string | null) => (url && url.startsWith("https://github.com/") ? url : undefined);

// Everything below comes from agents that read untrusted issue text: it is rendered as React text
// (escaped), never as HTML or markdown.

const CRITERION_STATUS: Record<AcceptanceCriterion["status"], { label: string; className: string }> = {
  MET: { label: "met", className: "text-emerald-700 dark:text-emerald-300" },
  NOT_MET: { label: "not met", className: "text-destructive" },
  CANNOT_CHECK: { label: "for you to check", className: "text-amber-700 dark:text-amber-300" },
  NOT_CHECKED: { label: "not checked", className: "text-amber-700 dark:text-amber-300" },
};

/** The acceptance lens's result, one line per criterion with its status and evidence. */
function AcceptanceSection({ section }: { section: Extract<OverviewSection, { kind: "acceptance" }> }) {
  return (
    <div className="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <code className="font-mono text-xs text-muted-foreground">{section.path}</code>
        <span className="font-medium">Acceptance criteria: {section.count}</span>
      </div>
      {section.criteria.length > 0 && (
        <ul className="space-y-1 pl-1 text-sm" aria-label="Acceptance criteria">
          {section.criteria.map((c) => (
            // break-words: evidence is a path such as `src/a.test.ts:12`, one long token that must wrap on a phone.
            <li key={c.id} className="whitespace-pre-wrap break-words">
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">{c.id}</span>
              <span className={`mr-1.5 font-mono text-xs ${CRITERION_STATUS[c.status].className}`}>{CRITERION_STATUS[c.status].label}</span>
              {c.text}
              {c.evidence && <span className="block pl-4 text-xs text-muted-foreground">{c.evidence}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ section }: { section: OverviewSection }) {
  if (section.kind === "acceptance") return <AcceptanceSection section={section} />;
  return (
    <div className="space-y-1 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <code className="font-mono text-xs text-muted-foreground">{section.path}</code>
        {section.kind === "verdict" && (
          <span className="font-mono font-medium">
            {section.key}: {section.value}
          </span>
        )}
        {section.kind === "unparsed" && <span className="text-destructive">does not parse</span>}
      </div>
      {section.kind === "unparsed" && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{section.problem}</p>}
      {section.kind !== "unparsed" && section.summary.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {section.summary.map((line, i) => (
            <li key={i} className="whitespace-pre-wrap break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
      {section.kind === "verdict" && section.blocking.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Blocking findings</p>
          <ul className="space-y-1 pl-1">
            {section.blocking.map((f) => (
              <li key={f.id} className="whitespace-pre-wrap break-words">
                <span className="mr-1.5 font-mono text-xs text-destructive">{f.severity}</span>
                {f.file && (
                  <code className="mr-1.5 font-mono text-xs text-muted-foreground">
                    {f.file}
                    {f.line ? `:${f.line}` : ""}
                  </code>
                )}
                {f.claim}
              </li>
            ))}
          </ul>
        </div>
      )}
      {section.kind === "verdict" && section.refuted > 0 && <p className="text-xs text-muted-foreground">{section.refuted} refuted by the verifier</p>}
    </div>
  );
}

function FileView({ project, id, path }: { project: string; id: string; path: string }) {
  const file = useQuery({ queryKey: ["run-file", project, id, path], queryFn: () => api.runFile(project, id, path) });
  return (
    <Card>
      <CardHeader>
        <code className="break-all font-mono text-sm">{path}</code>
      </CardHeader>
      <CardContent>
        {file.isPending && <p className="text-sm text-muted-foreground">Loading {path}...</p>}
        {file.error && <p className="text-sm text-destructive">{file.error.message}</p>}
        {file.data && (
          // Focusable so the keyboard can scroll it; a region, so its label is announced.
          <pre
            tabIndex={0}
            role="region"
            className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs"
            aria-label={`Contents of ${path}`}
          >
            {file.data.text}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * One run in full: its issue, why it waits, the verdicts of its run folder, its files and the
 * decisions on it. Keyed by the run, so an open file or a confirmation never carries over to another.
 */
export function RunDetail() {
  const { project = "", id = "" } = useParams();
  return <RunPage key={`${project}/${id}`} project={project} id={id} />;
}

function RunPage({ project, id }: { project: string; id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const detail = useQuery({ queryKey: ["run", project, id], queryFn: () => api.run(project, id) });
  const [file, setFile] = useState<string>();
  const [done, setDone] = useState<string>();
  // Opened from a link of the app, back goes where it came from; opened directly, to the Inbox.
  const back = () => (location.key === "default" ? navigate("/inbox") : navigate(-1));

  const data = detail.data;
  const run = data?.run;
  const url = githubUrl(data?.issue?.url ?? null);
  const binary = new Set(data?.binaryFiles ?? []);

  return (
    <section className="space-y-4">
      <Button size="sm" variant="ghost" onClick={back}>
        <ArrowLeft aria-hidden /> Back
      </Button>
      {detail.isPending && <p className="text-sm text-muted-foreground">Loading the run...</p>}
      {detail.error && <p className="text-sm text-destructive">{detail.error.message}</p>}
      {data && run && (
        <>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">
              {data.issue && <span className="mr-2 font-mono text-muted-foreground">#{data.issue.number}</span>}
              {data.issue?.title ?? run.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StateBadge state={run.state} />
              <code className="font-mono">{run.id}</code>
              <span>{run.projectName}</span>
              <span>{rounds(run)}</span>
              <span>{money(run.cost)}</span>
              <span title={run.updatedAt}>{ago(run.updatedAt)}</span>
              {url && (
                <a href={url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline">
                  Issue on GitHub <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </div>
          </div>

          <Card>
            <CardHeader>
              {run.state === "needs_human" ? (
                <Badge className="bg-amber-500/15 font-mono text-amber-700 dark:text-amber-300">{run.waitingGate ? `${run.waitingGate} gate` : "escalation"}</Badge>
              ) : (
                <h2 className="text-sm font-medium">Where it is</h2>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {run.reason ? <p className="whitespace-pre-wrap break-words text-sm">{run.reason}</p> : <p className="text-sm text-muted-foreground">No reason recorded.</p>}
              <OpenFeedback run={run} />
              <RunActions key={`${run.state}/${run.waitingGate ?? ""}`} run={run} onDone={setDone} />
              {/* Outside RunActions, which goes away once the run is no longer waiting for you. */}
              <p role="status" className="text-sm">
                {done}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-sm font-medium">Verdicts</h2>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.sections.length === 0 && <p className="text-sm text-muted-foreground">{data.hasRunDir ? "No verdicts yet." : "No run folder yet."}</p>}
              {data.sections.map((s) => (
                <Section key={s.path} section={s} />
              ))}
            </CardContent>
          </Card>

          {data.files.length > 0 && (
            <Card>
              <CardHeader>
                <h2 className="text-sm font-medium">Files</h2>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-wrap gap-1" aria-label="Run files">
                  {data.files.map((f) =>
                    binary.has(f) ? (
                      <li key={f} className="min-w-0 max-w-full px-3 py-2 text-xs">
                        <span className="break-all font-mono text-muted-foreground">{f}</span> <span className="text-muted-foreground">(not text, open it from the run folder)</span>
                      </li>
                    ) : (
                      <li key={f} className="min-w-0 max-w-full">
                        <Button
                          size="sm"
                          variant={file === f ? "secondary" : "ghost"}
                          aria-pressed={file === f}
                          className="h-auto min-h-8 max-w-full whitespace-normal break-all text-left font-mono"
                          onClick={() => setFile(file === f ? undefined : f)}
                        >
                          {f}
                        </Button>
                      </li>
                    ),
                  )}
                </ul>
              </CardContent>
            </Card>
          )}
          {file && <FileView project={project} id={id} path={file} />}
        </>
      )}
    </section>
  );
}
