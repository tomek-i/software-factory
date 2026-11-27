import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ExternalLink, Play, TriangleAlert } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { api, ApiError, type AuditFindingView, type AuditList, type AuditStatus, type AuditSummary, type ProjectInfo } from "../lib/api";
import { useProject } from "../lib/project";
import { ago, cn } from "../lib/utils";

const SCHEDULE: Record<AuditList["schedule"], string> = {
  off: "Scheduled audits are off. Turn them on in Settings, under Security.",
  weekly: "Audited every week by factory serve and factory work.",
  monthly: "Audited every month by factory serve and factory work.",
};

const STATUS_STYLE: Record<AuditStatus, string> = {
  complete: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
  skipped: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

const SEVERITY_STYLE: Record<AuditFindingView["severity"], string> = {
  critical: "bg-destructive/15 text-destructive",
  major: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  minor: "bg-muted text-muted-foreground",
};

function findingsText(audit: AuditSummary): string {
  if (audit.status !== "complete") return audit.problem ?? audit.status;
  return audit.findings === 0 ? "No findings" : `${audit.findings} finding${audit.findings === 1 ? "" : "s"}`;
}

function FileButton({ project, audit, finding, github }: { project: string; audit: string; finding: AuditFindingView; github: string | null }) {
  const queryClient = useQueryClient();
  const [confirmPublic, setConfirmPublic] = useState(false);
  const file = useMutation({
    mutationFn: (allowPublic: boolean) => api.fileFinding(project, audit, finding.id, allowPublic),
    onSuccess: () => {
      setConfirmPublic(false);
      void queryClient.invalidateQueries({ queryKey: ["audit", project] });
    },
    onError: (err) => setConfirmPublic(err instanceof ApiError && err.code === "public_repo"),
  });

  if (finding.issue !== undefined) {
    return github ? (
      <a href={`https://github.com/${github}/issues/${finding.issue}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm hover:underline">
        Issue #{finding.issue} <ExternalLink aria-hidden className="size-3" />
      </a>
    ) : (
      <span className="text-sm">Issue #{finding.issue}</span>
    );
  }
  if (confirmPublic) {
    return (
      <div role="alert" className="flex max-w-sm flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <p className="flex items-start gap-1.5">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-amber-600" />
          This repository is public: the issue would show this vulnerability to everyone before it is fixed. A private security advisory is safer.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="destructive" disabled={file.isPending} onClick={() => file.mutate(true)}>
            File anyway
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirmPublic(false)}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" disabled={file.isPending} onClick={() => file.mutate(false)}>
        File issue
      </Button>
      {file.error && !(file.error instanceof ApiError && file.error.code === "public_repo") && (
        <span className="text-xs text-destructive" role="alert">
          {file.error.message}
        </span>
      )}
    </div>
  );
}

function AuditFindings({ project, id, github }: { project: string; id: string; github: string | null }) {
  const audit = useQuery({ queryKey: ["audit", project, id], queryFn: () => api.audit(project, id) });
  if (audit.error) return <p className="text-sm text-destructive">{audit.error.message}</p>;
  if (!audit.data) return null;
  const { findings, notes } = audit.data;
  return (
    <div className="space-y-3">
      {notes.map((note) => (
        <p key={note} className="text-sm text-amber-700 dark:text-amber-400">
          {note}
        </p>
      ))}
      {findings.length === 0 && <p className="text-sm text-muted-foreground">This audit reported no findings.</p>}
      {findings.map((finding) => (
        <Card key={finding.id} className="space-y-2 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={SEVERITY_STYLE[finding.severity]}>{finding.severity}</Badge>
                {/* Written by the scan's agents: shown as text only. */}
                <span className="font-medium">{finding.claim}</span>
              </div>
              {finding.file && (
                <p className="text-sm text-muted-foreground">
                  {finding.file}
                  {finding.line ? `:${finding.line}` : ""}
                </p>
              )}
            </div>
            <FileButton project={project} audit={id} finding={finding} github={github} />
          </div>
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Evidence (goes into the issue as written)</summary>
            <p className="mt-2 text-sm whitespace-pre-wrap">{finding.evidence}</p>
          </details>
        </Card>
      ))}
    </div>
  );
}

function ProjectAudits({ project }: { project: ProjectInfo }) {
  const queryClient = useQueryClient();
  const audits = useQuery({ queryKey: ["audits", project.key], queryFn: () => api.audits(project.key) });
  const request = useMutation({ mutationFn: () => api.requestAudit(project.key), onSettled: () => queryClient.invalidateQueries({ queryKey: ["audits", project.key] }) });
  const [picked, setPicked] = useState<string>();
  const list = audits.data?.audits ?? [];
  const selected = list.find((a) => a.id === picked) ?? list[0];
  const state = audits.data?.state;

  return (
    <section className="space-y-3" aria-label={project.name}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{project.name}</h2>
        {audits.data && <span className="text-sm text-muted-foreground">{SCHEDULE[audits.data.schedule]}</span>}
        <span className="ml-auto text-sm text-muted-foreground" role="status">
          {state === "running" ? "Audit going on" : state === "requested" ? "Audit waiting for a free slot" : ""}
        </span>
        <Button size="sm" variant="outline" disabled={!audits.data || state !== undefined || request.isPending} onClick={() => request.mutate()}>
          <Play aria-hidden /> Run audit now
        </Button>
      </div>
      {request.error && (
        <p className="text-sm text-destructive" role="alert">
          {request.error.message}
        </p>
      )}
      {audits.error && <p className="text-sm text-destructive">{audits.error.message}</p>}
      {audits.data && list.length === 0 && <p className="text-sm text-muted-foreground">No audits yet.</p>}
      {list.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Commit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((audit) => (
                <TableRow
                  key={audit.id}
                  aria-selected={audit === selected}
                  className={cn("cursor-pointer", audit === selected && "bg-muted/60")}
                  onClick={() => setPicked(audit.id)}
                >
                  <TableCell className="whitespace-nowrap">
                    <button type="button" className="hover:underline" onClick={() => setPicked(audit.id)}>
                      {ago(audit.startedAt)}
                    </button>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{audit.commit.slice(0, 7)}</TableCell>
                  <TableCell>
                    <Badge className={STATUS_STYLE[audit.status]}>{audit.status}</Badge>
                  </TableCell>
                  <TableCell className="max-w-md truncate">{findingsText(audit)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {selected && selected.findings > 0 && <AuditFindings project={project.key} id={selected.id} github={audits.data?.github ?? null} />}
    </section>
  );
}

export function Audits() {
  const { project } = useProject();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const shown = projects.data?.filter((p) => p.status === "ok" && (project ? p.key === project : true)) ?? [];

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Audits</h1>
        <p className="text-sm text-muted-foreground">Whole-repository security scans of each default branch, with the claude-security Claude Code plugin.</p>
      </div>
      {projects.error && <p className="text-sm text-destructive">{projects.error.message}</p>}
      {shown.map((p) => (
        <ProjectAudits key={p.key} project={p} />
      ))}
    </div>
  );
}
