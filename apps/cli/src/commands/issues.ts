import { fetchIssue, syncIssues, type CommandRunner, type Issue } from "@factory/core";
import { isTrustedAuthor, type FactoryConfig } from "@factory/shared";
import { CliError, withProject } from "../context.js";
import { plain, type Style } from "../style.js";

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

function table(issues: Issue[], config: FactoryConfig, style: Style): string {
  if (issues.length === 0) return "No issues.";
  const width = Math.max(...issues.map((i) => String(i.number).length)) + 1;
  return issues
    .map((i) => {
      const mark = i.queued_at ? "Q" : " ";
      const number = `#${i.number}`;
      // Pad the plain number, then style it, so the columns stay aligned.
      const cell = style.detail(number) + " ".repeat(width - number.length);
      const closed = i.state === "closed" ? ` ${style.detail("(closed)")}` : "";
      const trust = isTrustedAuthor(config, i.author) ? "" : ` ${style.attention("(untrusted)")}`;
      return `${mark} ${cell}  ${i.title}${closed}  @${i.author}${trust}`;
    })
    .join("\n");
}

export const UNTRUSTED_NOTE =
  "  author is not in trust.authors: the issue text is treated as untrusted data and triage will wait for your approval";

export function runIssues(
  cwd: string,
  options: { queued?: boolean; all?: boolean },
  run?: CommandRunner,
  style: Style = plain,
): string {
  return withProject(
    cwd,
    ({ store, project, config }) => {
      const issues = store.listIssues({
        project_id: project.id,
        state: options.all ? undefined : "open",
        queued: options.queued ? true : undefined,
      });
      const footer = options.queued ? "" : "\n\nQ = queued for the factory. Queue with `factory queue <number...>`.";
      return table(issues, config, style) +(issues.length ? footer : "");
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
    ({ store, project, config }) =>
      numbers
        .map((n) => {
          try {
            // Queueing an issue that was never synced fetches just that issue.
            if (queued && !store.getIssue(project.id, n)) fetchIssue(store, project, n, run);
            const issue = store.setQueued(project.id, n, queued);
            const line = `${queued ? "Queued" : "Unqueued"} #${n} ${issue.title}`;
            return queued && !isTrustedAuthor(config, issue.author) ? `${line}\n${UNTRUSTED_NOTE}` : line;
          } catch (err) {
            return `Skipped #${n}: ${(err as Error).message}`;
          }
        })
        .join("\n"),
    run,
  );
}
