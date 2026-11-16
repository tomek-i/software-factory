import type { RunState } from "@factory/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Undo2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api, type RunRow } from "../lib/api";
import { Button } from "./ui/button";
import { Input, Select, Textarea } from "./ui/input";

type Mode = "approve" | "reject" | "resume" | "cancel";

const SUBMIT: Record<Mode, string> = { approve: "Approve", reject: "Reject", resume: "Resume", cancel: "Cancel run" };

/**
 * The decisions on a run waiting for a human: approve or reject at a gate, resume an escalation to
 * a stage, cancel. Shared by the Inbox card and the run's detail view, so both follow one set of rules.
 */
export function RunActions({ run }: { run: RunRow }) {
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
    );
  }

  return (
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
        <Button type="submit" size="sm" variant={mode === "approve" || mode === "resume" ? "default" : "destructive"} disabled={act.isPending || (needsReason && !message.trim())}>
          {SUBMIT[mode]}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode(undefined)}>
          Back
        </Button>
      </div>
    </form>
  );
}
