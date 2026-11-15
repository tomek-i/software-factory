import type { RunState } from "@factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Undo2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader } from "../components/ui/card";
import { Input, Select, Textarea } from "../components/ui/input";
import { api, type RunRow } from "../lib/api";
import { useProject } from "../lib/project";
import { ago } from "../lib/utils";

type Mode = "approve" | "reject" | "resume" | "cancel";

const SUBMIT: Record<Mode, string> = { approve: "Approve", reject: "Reject", resume: "Resume", cancel: "Cancel run" };

/** One run waiting for a decision, with its actions inline. */
function Waiting({ run }: { run: RunRow }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>();
  const [message, setMessage] = useState("");
  const [to, setTo] = useState<RunState | "">(run.resumeTargets[0] ?? "");
  const act = useMutation({
    mutationFn: (m: Mode) => {
      if (m === "approve") return api.approve(run, message.trim() || undefined);
      if (m === "reject") return api.reject(run, message);
      if (m === "resume") return api.resume(run, to as RunState, message);
      return api.cancel(run, message.trim() || undefined);
    },
    onSuccess: () => {
      setMode(undefined);
      setMessage("");
      return queryClient.invalidateQueries();
    },
  });
  // A reason is the service's rule for reject and resume; say so before asking it.
  const needsReason = mode === "reject" || mode === "resume";
  const open = (m: Mode) => {
    act.reset();
    setMode(m);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode) act.mutate(mode);
  };

  return (
    <Card>
      <CardHeader>
        <Badge className="bg-amber-500/15 font-mono text-amber-700 dark:text-amber-300">{run.waitingGate ? `${run.waitingGate} gate` : "escalation"}</Badge>
        <span className="font-medium">
          {run.issue !== null && <span className="mr-1.5 font-mono text-muted-foreground">#{run.issue}</span>}
          {run.title}
        </span>
        <span className="ml-auto text-xs text-muted-foreground" title={run.updatedAt}>
          {run.projectName} · {ago(run.updatedAt)}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {run.reason && <p className="text-sm">{run.reason}</p>}
        <p className="text-xs text-muted-foreground">
          Details: <code className="font-mono">factory show {run.id}</code>
        </p>
        {!mode && (
          <div className="flex flex-wrap gap-2">
            {run.waitingGate ? (
              <>
                <Button size="sm" onClick={() => open("approve")}>
                  <Check aria-hidden /> Approve
                </Button>
                <Button size="sm" variant="outline" onClick={() => open("reject")}>
                  <X aria-hidden /> Reject
                </Button>
              </>
            ) : (
              run.resumeTargets.length > 0 && (
                <Button size="sm" onClick={() => open("resume")}>
                  <Undo2 aria-hidden /> Resume
                </Button>
              )
            )}
            <Button size="sm" variant="ghost" onClick={() => open("cancel")}>
              <Ban aria-hidden /> Cancel run
            </Button>
          </div>
        )}
        {mode && (
          <form className="space-y-2" onSubmit={submit} aria-label={SUBMIT[mode]}>
            {mode === "resume" && (
              <label className="flex items-center gap-2 text-sm">
                Send it to
                <Select value={to} onChange={(e) => setTo(e.target.value as RunState)}>
                  {run.resumeTargets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {mode === "approve" ? (
              <Input aria-label="Note" placeholder="Note (optional)" value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
            ) : (
              <Textarea
                aria-label="Reason"
                placeholder={needsReason ? "Why (required)" : "Why (optional)"}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                autoFocus
              />
            )}
            {act.error && (
              <p className="text-sm text-destructive" role="alert">
                {act.error.message}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                variant={mode === "approve" || mode === "resume" ? "default" : "destructive"}
                disabled={act.isPending || (needsReason && !message.trim())}
              >
                {SUBMIT[mode]}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode(undefined)}>
                Back
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

export function Inbox() {
  const { project } = useProject();
  const runs = useQuery({ queryKey: ["runs", "waiting", project], queryFn: () => api.runs("waiting", project) });
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
                {run.issue !== null && <span className="mr-1.5 font-mono text-muted-foreground">#{run.issue}</span>}
                {run.title} <span className="text-xs text-muted-foreground">· {run.projectName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
