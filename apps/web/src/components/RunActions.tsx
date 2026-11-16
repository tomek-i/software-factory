import type { RunState } from "@factory/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, TriangleAlert, Undo2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type RunRow } from "../lib/api";
import { Button } from "./ui/button";
import { Input, Select, Textarea } from "./ui/input";

type Mode = "approve" | "reject" | "resume" | "cancel";

const SUBMIT: Record<Mode, string> = { approve: "Approve", reject: "Reject", resume: "Resume", cancel: "Cancel run" };
const APPROVE_ANYWAY = "Approve anyway";
// Amber like the gate badge: a warning to read first, not a refusal.
const WARNING = "bg-amber-600 text-white hover:bg-amber-600/90 dark:bg-amber-500 dark:text-black dark:hover:bg-amber-500/90";

/**
 * The decisions on a run waiting for a human: approve or reject at a gate, resume an escalation to
 * a stage, cancel. Shared by the Inbox card and the run's detail view, so both follow one set of rules.
 * With `warn` (e.g. a failed check on the PR), Approve says "Approve anyway": it still posts the
 * same approval; the warning is the caller's to explain.
 */
export function RunActions({ run, warn = false }: { run: RunRow; warn?: boolean }) {
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
  // Only a run parked for a human has decisions to make.
  if (run.state !== "needs_human") return null;
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

  if (!mode) {
    return (
      <div className="flex flex-wrap gap-2">
        {run.waitingGate ? (
          <>
            <Button size="sm" className={warn ? WARNING : undefined} onClick={() => open("approve")}>
              {warn ? <TriangleAlert aria-hidden /> : <Check aria-hidden />} {warn ? APPROVE_ANYWAY : SUBMIT.approve}
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
    );
  }

  const label = mode === "approve" && warn ? APPROVE_ANYWAY : SUBMIT[mode];
  return (
    <form className="space-y-2" onSubmit={submit} aria-label={label}>
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
          className={mode === "approve" && warn ? WARNING : undefined}
          disabled={act.isPending || (needsReason && !message.trim())}
        >
          {label}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode(undefined)}>
          Back
        </Button>
      </div>
    </form>
  );
}
