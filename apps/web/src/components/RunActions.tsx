import type { RunState } from "@factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, ListChecks, TriangleAlert, Undo2, Wrench, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { api, DISMISS_REASONS, type CodeScanningAlert, type DismissReason, type RunChecks, type RunRow } from "../lib/api";
import { COSTLY_TARGETS, failureMessage, TARGET_HELP, webLink } from "../lib/failure";
import { Button } from "./ui/button";
import { Input, Select, Textarea } from "./ui/input";

type Mode = "approve" | "reject" | "resume" | "cancel" | "checks";

// Amber like the gate badge: a warning to read first, not a refusal. White text needs amber-700 or
// darker for 4.5:1 contrast (amber-600 is about 3.2:1); dark mode puts black on amber-500.
const WARNING = "bg-amber-700 text-white hover:bg-amber-800 dark:bg-amber-500 dark:text-black dark:hover:bg-amber-500/90";

/** GitHub refuses a longer dismissal comment. */
const DISMISS_COMMENT_MAX = 280;

const checksKey = (run: RunRow) => ["checks", run.project, run.id];

/** What each decision did, said once it went through. */
const DONE: Record<Mode, (to: RunState | "") => string> = {
  approve: () => "Approved.",
  reject: () => "Rejected.",
  resume: (to) => `Sent back to ${to}.`,
  cancel: () => "Cancelled.",
  checks: (to) => `Sent back to ${to}.`,
};

/**
 * The decisions on a run waiting for a human: approve or reject at a gate, send it back to a stage
 * (with the failure it waits on, if any), dismiss a false-positive code scanning alert, cancel.
 * Shared by the Inbox card and the run's detail view, so both follow one set of rules.
 * With `warn` (e.g. a failed check on the PR), Approve says "Approve anyway": it still posts the
 * same approval; the warning is the caller's to explain. `onDone` is told what was done, to confirm it.
 */
export function RunActions({ run, warn = false, onDone }: { run: RunRow; warn?: boolean; onDone?: (what: string) => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>();
  const [message, setMessage] = useState("");
  const firstTarget = run.resumeTargets.includes("build") ? "build" : run.resumeTargets[0];
  const [to, setTo] = useState<RunState | "">(firstTarget ?? "");
  // A cap stopped the run: resumed with the same counters, it would stop again at once.
  const [resetLoops, setResetLoops] = useState(!!run.capReached);
  const helpId = useId();
  const act = useMutation({
    mutationFn: (m: Mode) => {
      if (m === "approve") return api.approve(run, message.trim() || undefined);
      if (m === "reject") return api.reject(run, message);
      if (m === "resume") return api.resume(run, to as RunState, message, resetLoops);
      return api.cancel(run, message.trim() || undefined);
    },
    onSuccess: (_data, m) => {
      setMode(undefined);
      setMessage("");
      onDone?.(DONE[m](to));
      return queryClient.invalidateQueries();
    },
  });
  // The failed checks with their alerts, asked of GitHub only when needed.
  const prefill = useMutation({
    mutationFn: () => (run.failure?.kind === "checks" ? queryClient.fetchQuery({ queryKey: checksKey(run), queryFn: () => api.checks(run) }) : Promise.resolve(undefined)),
  });
  // Only a run parked for a human has decisions to make.
  if (run.state !== "needs_human") return null;
  const gate = !!run.waitingGate;
  const canResume = run.resumeTargets.length > 0;
  const toBuilder = run.failure && run.resumeTargets.includes("build") ? run.failure : undefined;
  // Approving the merge gate past open review threads or failed checks merges despite them, for this commit only.
  const approveLabel = run.failure?.kind === "feedback" ? "Merge anyway" : warn ? "Approve anyway" : "Approve";
  // A reason is the service's rule for reject and resume; say so before asking it.
  const needsReason = mode === "reject" || mode === "resume";
  const open = (m: Mode) => {
    act.reset();
    // A message prefilled for another action (the builder's failure text) must not become this one's note.
    setMessage("");
    if (m === "resume") {
      setTo(firstTarget ?? "");
      setResetLoops(!!run.capReached);
    }
    setMode(m);
  };
  /** Open the resume form for the builder, with the failure as its editable message and fresh loops. */
  const sendToBuilder = async () => {
    if (!toBuilder) return;
    let checks: RunChecks | undefined;
    try {
      checks = await prefill.mutateAsync();
    } catch {
      // Without GitHub's alerts the check's name and link still say what failed.
    }
    act.reset();
    setTo("build");
    setResetLoops(true);
    setMessage(failureMessage(toBuilder, checks));
    setMode("resume");
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode) act.mutate(mode);
  };

  const closedNote = run.issueClosed && (
    <p className="rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-800 dark:text-amber-200" role="note">
      Issue #{run.issue} was closed on GitHub, so this work may be done elsewhere. Cancelling the run also closes PR #{run.issueClosed.pr} and deletes its branch.
    </p>
  );

  if (!mode) {
    return (
      <div className="space-y-2">
        {closedNote}
        <div className="flex flex-wrap gap-2">
          {gate && (
            <>
              <Button size="sm" className={warn ? WARNING : undefined} onClick={() => open("approve")}>
                {warn ? <TriangleAlert aria-hidden /> : <Check aria-hidden />} {approveLabel}
              </Button>
              <Button size="sm" variant="outline" onClick={() => open("reject")}>
                <X aria-hidden /> Reject
              </Button>
            </>
          )}
          {canResume && (
            <Button size="sm" variant={gate ? "outline" : "default"} onClick={() => open("resume")}>
              <Undo2 aria-hidden /> {gate ? "Send back to…" : "Resume"}
            </Button>
          )}
          {toBuilder && (
            <Button size="sm" variant="outline" onClick={sendToBuilder} disabled={prefill.isPending}>
              <Wrench aria-hidden /> Send to builder with this failure
            </Button>
          )}
          {run.failure?.kind === "checks" && (
            <Button size="sm" variant="outline" onClick={() => open("checks")}>
              <ListChecks aria-hidden /> Failed checks…
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => open("cancel")}>
            <Ban aria-hidden /> Cancel run
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "checks") return <FailedChecks run={run} onBack={() => setMode(undefined)} onSendToBuilder={toBuilder ? sendToBuilder : undefined} />;

  const submitLabel = { approve: approveLabel, reject: "Reject", resume: gate ? "Send back" : "Resume", cancel: "Cancel run" }[mode];
  const help = to ? TARGET_HELP[to] : undefined;
  return (
    <form className="space-y-2" onSubmit={submit} aria-label={submitLabel}>
      {mode === "cancel" && closedNote}
      {mode === "resume" && (
        <div className="space-y-1">
          <label className="flex flex-wrap items-center gap-2 text-sm">
            Send it to
            <Select value={to} onChange={(e) => setTo(e.target.value as RunState)} aria-describedby={helpId}>
              {run.resumeTargets.map((t) => (
                <option key={t} value={t} title={TARGET_HELP[t]}>
                  {t}
                </option>
              ))}
            </Select>
          </label>
          {help && (
            <p id={helpId} className="text-xs text-muted-foreground">
              {to}: {help}
            </p>
          )}
          {to && COSTLY_TARGETS.includes(to) && (
            <p className="rounded-md bg-amber-500/15 px-2 py-1 text-xs text-amber-800 dark:text-amber-200" role="note">
              Costs more: triage, the spec critic and the build all run again, and a gate may ask you again.
            </p>
          )}
          <label className="flex items-start gap-2 pt-1 text-sm">
            <input type="checkbox" className="mt-0.5 size-4" checked={resetLoops} onChange={(e) => setResetLoops(e.target.checked)} />
            <span>
              Reset loop counters
              <span className="block text-xs text-muted-foreground">
                {run.capReached
                  ? `It stopped because the ${run.capReached}: without fresh counters it stops again at once.`
                  : "Gives the build, review, spec and re-sync loops a fresh budget."}
              </span>
            </span>
          </label>
        </div>
      )}
      {mode === "approve" ? (
        <Input aria-label="Note" placeholder="Note (optional)" value={message} onChange={(e) => setMessage(e.target.value)} autoFocus />
      ) : (
        <Textarea
          aria-label="Reason"
          className={mode === "resume" ? "min-h-28" : undefined}
          placeholder={needsReason ? (mode === "resume" ? "What to do, e.g. what to fix (required)" : "Why (required)") : "Why (optional)"}
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
          className={mode === "approve" && warn ? WARNING : undefined}
          disabled={act.isPending || (needsReason && !message.trim())}
        >
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode(undefined)}>
          Back
        </Button>
      </div>
    </form>
  );
}

/** The required checks that failed on the run's PR: code scanning alerts can be dismissed, other checks only fixed. */
function FailedChecks({ run, onBack, onSendToBuilder }: { run: RunRow; onBack: () => void; onSendToBuilder?: () => void }) {
  const checks = useQuery({ queryKey: checksKey(run), queryFn: () => api.checks(run), staleTime: 30_000 });
  const [dismissing, setDismissing] = useState<number>();
  const [outcome, setOutcome] = useState<string>();

  return (
    <section className="space-y-3" aria-label="Failed checks">
      {checks.isPending && <p className="text-sm text-muted-foreground">Asking GitHub…</p>}
      {checks.error && (
        <p className="text-sm text-destructive" role="alert">
          {checks.error.message}
        </p>
      )}
      {checks.data && checks.data.failed.length === 0 && <p className="text-sm text-muted-foreground">No required check fails on PR #{checks.data.pr} now.</p>}
      {checks.data?.failed.map((check) => (
        <div key={check.name} className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">
            {webLink(check.link) ? (
              <a href={webLink(check.link)} target="_blank" rel="noreferrer noopener" className="underline">
                {check.name}
              </a>
            ) : (
              check.name
            )}{" "}
            <span className="font-normal text-muted-foreground">{check.alerts.length ? `code scanning, ${check.alerts.length} open alert${check.alerts.length > 1 ? "s" : ""}` : "failed"}</span>
          </p>
          {check.alerts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              A required check can't be accepted here: branch protection refuses the merge while it fails. Send the run to the builder to fix it.
            </p>
          ) : (
            <ul className="space-y-2">
              {check.alerts.map((alert) => (
                <li key={alert.number} className="space-y-2 text-sm">
                  <AlertLine alert={alert} />
                  {dismissing === alert.number ? (
                    <DismissForm
                      run={run}
                      alert={alert}
                      onCancel={() => setDismissing(undefined)}
                      onDone={(text) => {
                        setDismissing(undefined);
                        setOutcome(text);
                      }}
                    />
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setDismissing(alert.number)}>
                      Dismiss…
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {outcome && (
        <p className="text-sm" role="status">
          {outcome}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {onSendToBuilder && (
          <Button size="sm" variant="outline" onClick={onSendToBuilder}>
            <Wrench aria-hidden /> Send to builder with this failure
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
      </div>
    </section>
  );
}

function AlertLine({ alert }: { alert: CodeScanningAlert }) {
  const where = alert.file ? `${alert.file}${alert.line ? `:${alert.line}` : ""}` : undefined;
  return (
    <p className="break-words">
      <span className="font-mono text-xs">#{alert.number}</span> {alert.description} <span className="font-mono text-xs text-muted-foreground">{alert.rule}</span>{" "}
      <span className="text-xs text-muted-foreground">{alert.severity}</span>
      {where && <span className="block font-mono text-xs text-muted-foreground">{where}</span>}
      {webLink(alert.url) && (
        <a href={webLink(alert.url)} target="_blank" rel="noreferrer noopener" className="text-xs underline">
          Alert on GitHub
        </a>
      )}
    </p>
  );
}

function DismissForm({ run, alert, onCancel, onDone }: { run: RunRow; alert: CodeScanningAlert; onCancel: () => void; onDone: (outcome: string) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<DismissReason>("false positive");
  const [comment, setComment] = useState("");
  const dismiss = useMutation({
    mutationFn: () => api.dismiss(run, alert.number, reason, comment),
    onSuccess: (result) => {
      onDone(
        result.continued
          ? `Dismissed alert #${alert.number}. ${result.check} passes now, so the run goes back to merge.`
          : `Dismissed alert #${alert.number}. Still failing: ${result.failing.join(", ")}. The run keeps waiting.`,
      );
      return queryClient.invalidateQueries();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    dismiss.mutate();
  };
  return (
    <form className="space-y-2" onSubmit={submit} aria-label={`Dismiss alert #${alert.number}`}>
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Reason
        <Select value={reason} onChange={(e) => setReason(e.target.value as DismissReason)}>
          {DISMISS_REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </label>
      <Textarea
        aria-label="Comment"
        placeholder="Why, for GitHub and the run's record (required)"
        maxLength={DISMISS_COMMENT_MAX}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        autoFocus
      />
      <p className="text-xs text-muted-foreground">Recorded as your decision on the run. Once the check passes, the run goes back to merge.</p>
      {dismiss.error && (
        <p className="text-sm text-destructive" role="alert">
          {dismiss.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={dismiss.isPending || !comment.trim()}>
          Dismiss alert
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Back
        </Button>
      </div>
    </form>
  );
}
