import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ban, MessageSquareReply, RotateCcw } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { api, type Continuation, type RunRow } from "../lib/api";
import { Button } from "./ui/button";
import { Textarea } from "./ui/input";

type Mode = "answer" | "retriage" | "cancel";

/** What happens after triage is asked again: the worker only picks up a queued issue. */
const NEXT: Record<Continuation, string> = {
  ready: "Triage runs again shortly.",
  not_queued: "Triage runs again once the issue is queued.",
  ended: "",
};

/**
 * The decisions on a run waiting for its issue's author: answer its questions here (added to the
 * issue's description, which is what triage reads), triage again once the answers are in the issue
 * or the repo, or cancel. `onDone` is told what was done, to confirm it.
 */
export function AuthorActions({ run, onDone }: { run: RunRow; onDone?: (what: string) => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>();
  const [text, setText] = useState("");
  const helpId = useId();
  const act = useMutation({
    mutationFn: async (m: Mode): Promise<string> => {
      if (m === "cancel") {
        await api.cancel(run, text.trim() || undefined);
        return "Cancelled.";
      }
      const answered = await api.answer(run, m === "answer" ? text.trim() : undefined);
      const done = m === "answer" ? "Added your answers to the issue." : "Sent back to triage.";
      return `${done} ${NEXT[answered.continuation]}`.trim();
    },
    onSuccess: (what) => {
      setMode(undefined);
      setText("");
      onDone?.(what);
      return queryClient.invalidateQueries();
    },
  });
  if (run.state !== "needs_info") return null;

  const open = (m: Mode) => {
    act.reset();
    setText("");
    setMode(m);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (mode) act.mutate(mode);
  };

  if (!mode) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => open("answer")}>
          <MessageSquareReply aria-hidden /> Answer
        </Button>
        <Button size="sm" variant="outline" onClick={() => open("retriage")}>
          <RotateCcw aria-hidden /> Triage again
        </Button>
        <Button size="sm" variant="ghost" onClick={() => open("cancel")}>
          <Ban aria-hidden /> Cancel run
        </Button>
      </div>
    );
  }

  const submitLabel = { answer: "Add to the issue and triage again", retriage: "Triage again", cancel: "Cancel run" }[mode];
  return (
    <form className="space-y-2" onSubmit={submit} aria-label={submitLabel}>
      {mode === "answer" && (
        <>
          <Textarea
            aria-label="Answers"
            aria-describedby={helpId}
            className="min-h-32"
            placeholder="Your answers to the questions above (required)"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <p id={helpId} className="text-xs text-muted-foreground">
            Added to the issue's description under Answers. Triage reads the description, not the comments on GitHub.
          </p>
        </>
      )}
      {mode === "retriage" && (
        <p className="text-sm text-muted-foreground">Triage reads the issue again as it is now. Use this once the answers are in the issue's description or in the repo.</p>
      )}
      {mode === "cancel" && (
        <Textarea aria-label="Reason" placeholder="Why (optional)" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      )}
      {act.error && (
        <p className="text-sm text-destructive" role="alert">
          {act.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant={mode === "cancel" ? "destructive" : "default"} disabled={act.isPending || (mode === "answer" && !text.trim())}>
          {submitLabel}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode(undefined)}>
          Back
        </Button>
      </div>
    </form>
  );
}
