import { fetchIssue, syncIssues, type CommandRunner, type Issue } from "@factory/core";
import { CliError, withProject } from "../context.js";

export function runSync(cwd: string, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project }) => {
      const result = syncIssues(store, project, run);
      const queued = store.listIssues({ project_id: project.id, queued: true }).length;
      return `Synced ${project.github_repo}: ${result.open} open, ${result.closed} closed since last sync, ${queued} queued.`;
    },
    run,
  );
}

function table(issues: Issue[]): string {
  if (issues.length === 0) return "No issues.";
  const width = Math.max(...issues.map((i) => String(i.number).length)) + 1;
  return issues
    .map((i) => {
      const mark = i.queued_at ? "Q" : " ";
      const closed = i.state === "closed" ? " (closed)" : "";
      return `${mark} ${`#${i.number}`.padEnd(width)}  ${i.title}${closed}  @${i.author}`;
    })
    .join("\n");
}

export function runIssues(cwd: string, options: { queued?: boolean; all?: boolean }, run?: CommandRunner): string {
  return withProject(
    cwd,
    ({ store, project }) => {
      const issues = store.listIssues({
        project_id: project.id,
        state: options.all ? undefined : "open",
        queued: options.queued ? true : undefined,
      });
      const footer = options.queued ? "" : "\n\nQ = queued for the factory. Queue with `factory queue <number...>`.";
      return table(issues) + (issues.length ? footer : "");
    },
    run,
  );
}

function parseNumbers(values: string[]): number[] {
  return values.map((v) => {
    const n = Number(v.replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) throw new CliError(`"${v}" is not an issue number`);
    return n;
  });
}

export function runQueue(cwd: string, values: string[], queued: boolean, run?: CommandRunner): string {
  const numbers = parseNumbers(values);
  return withProject(
    cwd,
    ({ store, project }) =>
      numbers
        .map((n) => {
          try {
            // Queueing an issue that was never synced fetches just that issue.
            if (queued && !store.getIssue(project.id, n)) fetchIssue(store, project, n, run);
            const issue = store.setQueued(project.id, n, queued);
            return `${queued ? "Queued" : "Unqueued"} #${n} ${issue.title}`;
          } catch (err) {
            return `Skipped #${n}: ${(err as Error).message}`;
          }
        })
        .join("\n"),
    run,
  );
}
