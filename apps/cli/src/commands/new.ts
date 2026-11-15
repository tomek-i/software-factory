import { relative } from "node:path";
import {
  approveDraft,
  discardPendingDraft,
  draftIssue,
  ensureDraftsIgnored,
  FactoryEvents,
  pendingDrafts,
  type CommandRunner,
  type DraftOutcome,
  type IssueWriterPort,
  type PublishedDraft,
} from "@factory/core";
import { CliError, withProject, withProjectAsync, type ProjectContext } from "../context.js";
import { plain, type Style } from "../style.js";
import { formatEvent } from "./runs.js";

export interface NewDeps {
  run?: CommandRunner;
  /** Environment for the agent (tests point FACTORY_CLAUDE_BIN at the fake). */
  env?: NodeJS.ProcessEnv;
  github?: IssueWriterPort;
  print?: (line: string) => void;
  style?: Style;
}

export interface NewOptions {
  approve?: string;
  discard?: string;
  list?: boolean;
}

/**
 * `factory new "<idea>"`: draft an issue with the issue writer, then create it or wait for approval
 * (`gates.issue_writer`). `--approve`, `--discard` and `--list` handle saved drafts.
 */
export async function runNew(cwd: string, idea: string[], options: NewOptions, deps: NewDeps = {}): Promise<string> {
  const text = idea.join(" ").trim();
  const modes = [text !== "", options.approve !== undefined, options.discard !== undefined, options.list === true].filter(Boolean);
  if (modes.length !== 1) throw new CliError('Give an idea (`factory new "<idea>"`), or one of --approve <draft>, --discard <draft>, --list.');
  if (options.list) return withProject(cwd, (ctx) => listPending(ctx, deps.style ?? plain, deps.run), deps.run);
  if (options.discard !== undefined) return withProject(cwd, (ctx) => discard(ctx, options.discard!, deps.run), deps.run);
  if (options.approve !== undefined) return withProject(cwd, (ctx) => approve(ctx, options.approve!, deps), deps.run);
  return withProjectAsync(cwd, (ctx) => draftIdea(ctx, text, deps), deps.run);
}

async function draftIdea(ctx: ProjectContext, idea: string, deps: NewDeps): Promise<string> {
  const print = deps.print ?? console.log;
  const style = deps.style ?? plain;
  const added = ensureDraftsIgnored(ctx);
  if (added.length) print(`Added ${added.join(", ")} to .gitignore`);

  const events = new FactoryEvents();
  events.on((e) => {
    const line = formatEvent(e, style);
    if (line) print(line);
  });
  // Ctrl+C stops the agent instead of leaving it running without anyone to read its draft.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  let outcome: DraftOutcome;
  try {
    outcome = await draftIssue(ctx, idea, { ...createDeps(deps), env: deps.env, events, signal: controller.signal });
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (outcome.kind === "created") return describePublished(outcome.published, style);

  const { id, file, text, reasons } = outcome;
  const fileRef = relative(ctx.root, file);
  return [
    text.trim(),
    "",
    `Draft ${style.detail(id)} ${style.attention("is waiting for you")}: ${reasons.join("; ")}`,
    style.hint(`Edit ${fileRef} if you like, then create it with \`factory new --approve ${id}\`, or drop it with \`factory new --discard ${id}\`.`),
  ].join("\n");
}

/**
 * How a draft is created from the CLI. The draft is printed in full first, whatever the gate: it
 * becomes a trusted issue, so what is about to be created is always on screen.
 */
function createDeps(deps: NewDeps) {
  return { run: deps.run, github: deps.github, onCreate: (text: string) => (deps.print ?? console.log)(`${text.trim()}\n`) };
}

function describePublished(published: PublishedDraft, style: Style): string {
  const { issue, subIssues, queued } = published;
  const lines = [
    subIssues.length ? `Created #${issue.number} ${issue.title}, with sub-issues:` : `Created #${issue.number} ${issue.title}.`,
    ...subIssues.map((s) => `  #${s.number} ${s.title}`),
    `Queued ${queued.map((n) => `#${n}`).join(", ")}.`,
    style.hint(`Run ${queued.length > 1 ? "them" : "it"} with \`factory run ${queued.join(" ")}\`.`),
  ];
  return lines.join("\n");
}

function approve(ctx: ProjectContext, ref: string, deps: NewDeps): string {
  return describePublished(approveDraft(ctx, ref, createDeps(deps)), deps.style ?? plain);
}

function discard(ctx: ProjectContext, ref: string, run?: CommandRunner): string {
  const entry = discardPendingDraft(ctx, ref, run);
  const kept = entry.created.length ? ` Issues already created from it stay on GitHub: ${entry.created.map((n) => `#${n}`).join(", ")}.` : "";
  return `Discarded ${entry.id}.${kept}`;
}

function listPending(ctx: ProjectContext, style: Style, run?: CommandRunner): string {
  const drafts = pendingDrafts(ctx, run);
  if (drafts.length === 0) return 'No pending drafts. Start one with `factory new "<idea>"`.';
  const width = Math.max(...drafts.map((d) => d.id.length));
  return drafts
    .map((d) => {
      const id = style.detail(d.id) + " ".repeat(width - d.id.length);
      if (d.refusal) return `${id}  ${style.attention("(refused)")} ${d.idea}  ${style.detail("tracked by git")}`;
      if (!d.draft) return `${id}  ${style.attention("(invalid)")} ${d.idea}  ${style.detail(d.problems[0] ?? "")}`;
      const subs = d.draft.subIssues.length ? ` (+${d.draft.subIssues.length} sub-issues)` : "";
      const escalated = d.draft.decision === "ESCALATE" ? ` ${style.attention("(escalated)")}` : "";
      return `${id}  ${d.draft.issue.title}${subs}${escalated}`;
    })
    .join("\n");
}
