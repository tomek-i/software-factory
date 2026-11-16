import { useMutation, useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button } from "../components/ui/button";
import { Select, Textarea } from "../components/ui/input";
import { api } from "../lib/api";
import { useProject } from "../lib/project";
import { draftPath } from "./Draft";

/**
 * `factory new` in the browser: pick a project, describe the idea, and the issue writer drafts the
 * issue. Its page (Draft) follows the agent and shows the draft or what was created.
 */
export function NewIssue() {
  const { project } = useProject();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const usable = projects.data?.filter((p) => p.status === "ok") ?? [];
  const [picked, setPicked] = useState("");
  // The project picked here, else the header's, else the first that opens.
  const target = picked || (usable.some((p) => p.key === project) ? project! : (usable[0]?.key ?? ""));
  const [idea, setIdea] = useState("");
  const [queue, setQueue] = useState(false);
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => api.startDraft(target, idea, queue),
    onSuccess: ({ id }) => navigate(draftPath(target, id)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    start.mutate();
  };

  return (
    <section className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">New issue</h1>
      <p className="text-sm text-muted-foreground">
        The issue writer reads the repository and drafts an issue from your idea, split into sub-issues when it is big, as{" "}
        <code className="font-mono">factory new</code> does. The project's <code className="font-mono">issue_writer</code> gate decides whether it is created on
        GitHub right away or waits here for you.
      </p>
      <form className="space-y-3" onSubmit={submit} aria-label="New issue">
        <label className="flex items-center gap-2 text-sm">
          Project
          <Select value={target} onChange={(e) => setPicked(e.target.value)}>
            {usable.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <Textarea aria-label="Idea" placeholder="What should the issue be about?" rows={6} value={idea} onChange={(e) => setIdea(e.target.value)} autoFocus />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={queue} onChange={(e) => setQueue(e.target.checked)} />
          Queue the issues for the factory once they are created
        </label>
        {projects.data && usable.length === 0 && <p className="text-sm text-muted-foreground">No project opens. Run `factory init` in a repository first.</p>}
        {start.error && (
          <p className="whitespace-pre-wrap text-sm text-destructive" role="alert">
            {start.error.message}
          </p>
        )}
        <Button type="submit" disabled={!target || !idea.trim() || start.isPending}>
          <Lightbulb aria-hidden /> Start the issue writer
        </Button>
      </form>
    </section>
  );
}
