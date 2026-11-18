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
  /** Queue the created issues for the factory; only with an idea or --approve. */
  queue?: boolean;
}

/**
 * `factory new "<idea>"`: draft an issue with the issue writer, then create it or wait for approval
 * (`gates.issue_writer`). `--approve`, `--discard` and `--list` handle saved drafts. Created issues
 * are queued only with `--queue`.
 */
export async function runNew(cwd: string, idea: string[], options: NewOptions, deps: NewDeps = {}): Promise<string> {
  const text = idea.join(" ").trim();
  const modes = [text !== "", options.approve !== undefined, options.discard !== undefined, options.list === true].filter(Boolean);
  if (modes.length !== 1) throw new CliError('Give an idea (`factory new "<idea>"`), or one of --approve <draft>, --discard <draft>, --list.');
  if (options.queue && (options.list || options.discard !== undefined)) {
    throw new CliError("--queue only goes with an idea or --approve <draft>.");
  }
  const queue = options.queue === true;
  if (options.list) return withProject(cwd, (ctx) => listPending(ctx, deps.style ?? plain, deps.run), deps.run);
  if (options.discard !== undefined) return withProject(cwd, (ctx) => discard(ctx, options.discard!, deps.run), deps.run);
  if (options.approve !== undefined) return withProject(cwd, (ctx) => approve(ctx, options.approve!, queue, deps), deps.run);
  return withProjectAsync(cwd, (ctx) => draftIdea(ctx, text, queue, deps), deps.run);
}

async function draftIdea(ctx: ProjectContext, idea: string, queue: boolean, deps: NewDeps): Promise<string> {
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
    outcome = await draftIssue(ctx, idea, { run: deps.run, env: deps.env, github: deps.github, events, signal: controller.signal, queue });
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (outcome.kind === "ready") return approve(ctx, outcome.id, queue, deps);

  const { id, file, text, reasons } = outcome;
  const fileRef = relative(ctx.root, file);
  // The --queue choice is not saved with the draft, so the hint carries it to the approval.
  const approveCmd = `factory new --approve ${id}${queue ? " --queue" : ""}`;
  return [
    text.trim(),
    "",
    `Draft ${style.detail(id)} ${style.attention("is waiting for you")}: ${reasons.join("; ")}`,
    style.hint(`Edit ${fileRef} if you like, then create it with \`${approveCmd}\`, or drop it with \`factory new --discard ${id}\`.`),
  ].join("\n");
}

/**
 * How a draft is created from the CLI. The draft is printed in full first, whatever the gate: it
 * becomes a trusted issue, so what is about to be created is always on screen.
 */
function createDeps(deps: NewDeps, queue: boolean) {
  return { run: deps.run, github: deps.github, queue, onCreate: (text: string) => (deps.print ?? console.log)(`${text.trim()}\n`) };
}

function describePublished(published: PublishedDraft, style: Style): string {
  const { issue, subIssues, buildable, queued } = published;
  const created = [
    subIssues.length ? `Created #${issue.number} ${issue.title}, with sub-issues:` : `Created #${issue.number} ${issue.title}.`,
    ...subIssues.map((s) => `  #${s.number} ${s.title}`),
  ];
  const pronoun = buildable.length > 1 ? "them" : "it";
  const numbers = buildable.join(" ");
  // Queued or not is the state to notice, so it is plain either way; only the next command is a hint.
  const lines = queued.length
    ? [...created, `Queued ${queued.map((n) => `#${n}`).join(", ")}.`, style.hint(`Run ${pronoun} with \`factory run ${numbers}\`.`)]
    : [...created, "Not queued.", style.hint(`Queue ${pronoun} with \`factory queue ${numbers}\`, or run ${pronoun} now with \`factory run ${numbers}\`.`)];
  return lines.join("\n");
}

function approve(ctx: ProjectContext, ref: string, queue: boolean, deps: NewDeps): string {
  return describePublished(approveDraft(ctx, ref, createDeps(deps, queue)), deps.style ?? plain);
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
