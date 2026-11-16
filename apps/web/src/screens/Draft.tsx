import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CircleStop, Save, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Input, Select, Textarea } from "../components/ui/input";
import { api, ApiError, type AgentEvent, type DraftDetail, type DraftEdit, type DraftIssue, type DraftView, type PublishedDraft } from "../lib/api";
import { activityLine } from "../lib/events";
import { githubUrl } from "./RunDetail";

/** Where a draft's page lives: the New issue screen and the Inbox link here. */
export const draftPath = (project: string, id: string) => `/new/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;

// Drafts are an agent's writing: everything is rendered as React text (escaped), never as HTML or markdown.

function Progress({ events, running }: { events: AgentEvent[]; running: boolean }) {
  const lines = events.map(activityLine).filter((l): l is string => l !== undefined);
  if (!running && lines.length === 0) return null;
  return (
    <ol className="max-h-64 space-y-0.5 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs" aria-label="Issue writer's progress">
      {lines.map((line, i) => (
        <li key={i} className="whitespace-pre-wrap">
          {line}
        </li>
      ))}
      {running && <li className="text-muted-foreground">working…</li>}
    </ol>
  );
}

function IssueLink({ issue, note }: { issue: PublishedDraft["issue"]; note?: string }) {
  const url = githubUrl(issue.url);
  const label = (
    <>
      <span className="mr-1.5 font-mono text-muted-foreground">#{issue.number}</span>
      {issue.title}
    </>
  );
  return (
    <li>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="hover:underline">
          {label}
        </a>
      ) : (
        label
      )}
      {note && <span className="ml-1.5 text-xs text-muted-foreground">{note}</span>}
    </li>
  );
}

function Created({ published }: { published: PublishedDraft }) {
  const { issue, subIssues, buildable, queued } = published;
  const them = buildable.length > 1 ? "them" : "it";
  return (
    <Card>
      <CardHeader>
        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">created</Badge>
        <span className="font-medium">Created on GitHub</span>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <ul className="space-y-1">
          <IssueLink issue={issue} note={subIssues.length ? "parent" : undefined} />
          {subIssues.map((s) => (
            <IssueLink key={s.number} issue={s} note="sub-issue" />
          ))}
        </ul>
        <p className="text-muted-foreground">
          {queued.length
            ? `Queued ${queued.map((n) => `#${n}`).join(", ")} for the factory.`
            : `Not queued. Queue ${them} from the Backlog when you want the factory to build ${them}.`}
        </p>
      </CardContent>
    </Card>
  );
}

interface Fields {
  title: string;
  ui: boolean;
  risk: string;
  body: string;
  /** As typed, e.g. "1, 2". */
  dependsOn: string;
}

const fieldsOf = (issue: DraftIssue): Fields => ({ title: issue.title, ui: issue.ui, risk: issue.risk, body: issue.body, dependsOn: issue.dependsOn.join(", ") });

/** "1, #2" as positions, or what isn't one: the server would refuse it anyway, but can't be sent a non-number. */
function positions(text: string): { numbers: number[]; bad: string[] } {
  const parts = text
    .split(",")
    .map((p) => p.trim().replace(/^#/, ""))
    .filter(Boolean);
  return { numbers: parts.map(Number).filter(Number.isInteger), bad: parts.filter((p) => !Number.isInteger(Number(p))) };
}

function IssueFields({ name, fields, sub, onChange }: { name: string; fields: Fields; sub: boolean; onChange: (f: Fields) => void }) {
  const set = (patch: Partial<Fields>) => onChange({ ...fields, ...patch });
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{name}</legend>
      <Input aria-label={`${name} title`} value={fields.title} onChange={(e) => set({ title: e.target.value })} />
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={fields.ui} onChange={(e) => set({ ui: e.target.checked })} />
          UI change
        </label>
        <label className="flex items-center gap-2">
          Risk
          <Select aria-label={`${name} risk`} value={fields.risk} onChange={(e) => set({ risk: e.target.value })}>
            {["LOW", "MEDIUM", "HIGH"].map((r) => (
              <option key={r} value={r}>
                {r.toLowerCase()}
              </option>
            ))}
          </Select>
        </label>
        {sub && (
          <label className="flex items-center gap-2">
            Depends on sub-issues
            <Input aria-label={`${name} depends on`} className="w-28" placeholder="e.g. 1, 2" value={fields.dependsOn} onChange={(e) => set({ dependsOn: e.target.value })} />
          </label>
        )}
      </div>
      <Textarea aria-label={`${name} body`} className="min-h-64 font-mono text-xs" value={fields.body} onChange={(e) => set({ body: e.target.value })} />
    </fieldset>
  );
}

type Action = "save" | "publish" | "discard";

/** The draft's issues as fields. Saving and publishing go through the server's validation, `factory new --approve`'s. */
function Editor({ pending }: { pending: DraftView & { draft: NonNullable<DraftView["draft"]> } }) {
  const { project, id, draft } = pending;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const initial = { issue: fieldsOf(draft.issue), subIssues: draft.subIssues.map(fieldsOf) };
  const [issue, setIssue] = useState(initial.issue);
  const [subIssues, setSubIssues] = useState(initial.subIssues);
  const [queue, setQueue] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = JSON.stringify({ issue, subIssues }) !== JSON.stringify(initial);

  const badPositions = subIssues.flatMap((s, i) => positions(s.dependsOn).bad.map((p) => `sub-issue ${i + 1}: DEPENDS_ON ${p} is not a sub-issue number`));
  const edit = (): DraftEdit => ({
    issue: { title: issue.title, ui: issue.ui, risk: issue.risk, body: issue.body },
    subIssues: subIssues.map((s) => ({ title: s.title, ui: s.ui, risk: s.risk, body: s.body, dependsOn: positions(s.dependsOn).numbers })),
  });
  const act = useMutation({
    mutationFn: async (action: Action) => {
      if (action === "discard") return api.discardDraft(project, id);
      if (dirty) await api.saveDraft(project, id, edit());
      if (action === "publish") return api.publishDraft(project, id, queue);
    },
    onSuccess: (_data, action) => {
      if (action === "discard") navigate("/inbox");
      return queryClient.invalidateQueries();
    },
  });
  const blocked = badPositions.length > 0;

  return (
    <form
      className="space-y-3"
      aria-label="Draft"
      onSubmit={(e) => {
        e.preventDefault();
        act.mutate("save");
      }}
    >
      <IssueFields name={draft.subIssues.length ? "Parent issue" : "Issue"} fields={issue} sub={false} onChange={setIssue} />
      {subIssues.map((s, i) => (
        <IssueFields key={i} name={`Sub-issue ${i + 1}`} fields={s} sub onChange={(f) => setSubIssues(subIssues.map((x, k) => (k === i ? f : x)))} />
      ))}
      {(act.error || blocked) && (
        <p className="whitespace-pre-wrap text-sm text-destructive" role="alert">
          {blocked ? badPositions.join("\n") : act.error?.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" disabled={!dirty || blocked || act.isPending}>
          <Save aria-hidden /> Save
        </Button>
        <Button disabled={blocked || act.isPending} onClick={() => act.mutate("publish")}>
          <Send aria-hidden /> {dirty ? "Save and create on GitHub" : "Create on GitHub"}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
          Queue for the factory
        </label>
        <span className="ml-auto flex items-center gap-2">
          {confirmDiscard ? (
            <>
              <span className="text-sm">Discard this draft?</span>
              <Button variant="destructive" size="sm" disabled={act.isPending} onClick={() => act.mutate("discard")}>
                Discard
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(true)}>
              <Trash2 aria-hidden /> Discard…
            </Button>
          )}
        </span>
      </div>
    </form>
  );
}

/** A draft that can't be edited here: refused, or not parsing. Shown as it is, with a discard. */
function Unusable({ pending }: { pending: DraftView & { text: string | null } }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const discard = useMutation({
    mutationFn: () => api.discardDraft(pending.project, pending.id),
    onSuccess: () => {
      navigate("/inbox");
      return queryClient.invalidateQueries();
    },
  });
  return (
    <div className="space-y-3">
      {pending.refusal ? (
        <p className="text-sm text-destructive">This draft can't be created: {pending.refusal}.</p>
      ) : (
        <div className="text-sm">
          <p className="text-destructive">This draft does not parse, so it has no fields to edit. Fix its draft.md by hand, or discard it:</p>
          <ul className="list-disc pl-5">
            {pending.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {pending.text !== null && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-xs" aria-label="Draft text">
          {pending.text}
        </pre>
      )}
      {discard.error && (
        <p className="text-sm text-destructive" role="alert">
          {discard.error.message}
        </p>
      )}
      <Button variant="destructive" size="sm" disabled={discard.isPending} onClick={() => discard.mutate()}>
        <Trash2 aria-hidden /> Discard
      </Button>
    </div>
  );
}

function Pending({ pending }: { pending: NonNullable<DraftDetail["pending"]> }) {
  const { draft } = pending;
  return (
    <div className="space-y-3">
      {pending.created.length > 0 && (
        <p className="text-sm">
          Already created from it: {pending.created.map((n) => `#${n}`).join(", ")}. Creating it again only does the rest.
        </p>
      )}
      {draft && draft.decision === "ESCALATE" && (
        <div className="text-sm">
          <p className="font-medium">The issue writer asks you to look:</p>
          <ul className="list-disc pl-5">
            {draft.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {draft && !pending.refusal ? <Editor key={pending.text ?? ""} pending={{ ...pending, draft }} /> : <Unusable pending={pending} />}
    </div>
  );
}

/** One draft: the issue writer's progress while it works, then what was created, or the draft to edit and create. */
export function Draft() {
  const { project = "", id = "" } = useParams();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["draft", project, id], queryFn: () => api.draft(project, id) });
  const stop = useMutation({ mutationFn: () => api.stopDraft(project, id), onSuccess: () => queryClient.invalidateQueries() });
  const data = detail.data;
  const running = data?.job?.running === true || data?.pending?.running === true;
  const result = data?.job?.result;

  return (
    <section className="max-w-4xl space-y-4">
      <Link to="/new" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> New issue
      </Link>
      {detail.error && (
        <p className="text-sm text-destructive">
          {detail.error instanceof ApiError && detail.error.status === 404 ? "No such draft: it was created or discarded, or never existed." : detail.error.message}
        </p>
      )}
      {data && (
        <>
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="text-xl font-semibold">{data.pending?.draft?.issue.title ?? "Draft"}</h1>
            <code className="font-mono text-xs text-muted-foreground">{data.id}</code>
            <span className="text-xs text-muted-foreground">· {data.projectName}</span>
          </div>
          {data.pending?.idea && <p className="whitespace-pre-wrap text-sm text-muted-foreground">Idea: {data.pending.idea}</p>}
          <Progress events={data.job?.events ?? []} running={running} />
          {running && (
            <Button size="sm" variant="outline" disabled={stop.isPending} onClick={() => stop.mutate()}>
              <CircleStop aria-hidden /> Stop the issue writer
            </Button>
          )}
          {result?.kind === "published" && <Created published={result.published} />}
          {result?.kind === "failed" && (
            <p className="whitespace-pre-wrap text-sm text-destructive" role="alert">
              {result.error}
            </p>
          )}
          {result?.kind === "waiting" && data.pending && <p className="text-sm font-medium">Waiting for you: {result.reasons.join("; ")}</p>}
          {data.pending && !running && <Pending pending={data.pending} />}
        </>
      )}
    </section>
  );
}
