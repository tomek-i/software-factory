import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  createAgentRunner,
  discardDraft,
  DraftError,
  type DraftEntry,
  ensureGitignore,
  FactoryEvents,
  ghPort,
  listDrafts,
  loadTrustedConfig,
  parseDraft,
  publishDraft,
  resolveGate,
  trustedReader,
  writeDraft,
  type CommandRunner,
  type IssueWriterPort,
  type PublishedDraft,
  type WrittenDraft,
} from "@factory/core";
import { VerdictParseError } from "@factory/shared";
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
  if (options.list) return withProject(cwd, (ctx) => listPending(ctx, deps.style ?? plain), deps.run);
  if (options.discard !== undefined) return withProject(cwd, (ctx) => discard(ctx, options.discard!), deps.run);
  if (options.approve !== undefined) return withProject(cwd, (ctx) => approve(ctx, options.approve!, deps), deps.run);
  return withProjectAsync(cwd, (ctx) => draftIdea(ctx, text, deps), deps.run);
}

async function draftIdea(ctx: ProjectContext, idea: string, deps: NewDeps): Promise<string> {
  const { root, project } = ctx;
  const print = deps.print ?? console.log;
  const style = deps.style ?? plain;
  // Repos set up before drafts existed: keep them out of git the way `factory init` does.
  const added = ensureGitignore(root, [".factory/drafts/"]);
  if (added.length) print(`Added ${added.join(", ")} to .gitignore`);

  // The gate, the model and the prompt steer an agent, so they come from the default branch.
  const defaultBranch = ctx.config.project.default_branch;
  const read = trustedReader(project.repo_path, defaultBranch, deps.run);
  const config = loadTrustedConfig(read, defaultBranch);

  const events = new FactoryEvents();
  events.on((e) => {
    const line = formatEvent(e, style);
    if (line) print(line);
  });
  // Ctrl+C stops the agent instead of leaving it running without anyone to read its draft.
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  let written: WrittenDraft;
  try {
    written = await writeDraft({ root, config, read, runAgent: createAgentRunner({ events, env: deps.env }), idea, signal: controller.signal });
  } finally {
    process.off("SIGINT", onSigint);
  }

  const { id, file, turn } = written;
  const fileRef = relative(root, file);
  const drop = `\`factory new --discard ${id}\``;
  if (turn.status === "failed") {
    const { outcome } = turn.agent;
    if (outcome.kind === "rate_limited") {
      throw new CliError(`Usage limit reached${outcome.resetsAt ? ` (resets ${outcome.resetsAt})` : ""}. Drop the empty draft with ${drop} and try again after that.`);
    }
    const detail = outcome.kind === "error" ? `${outcome.subtype}: ${outcome.message}` : outcome.kind;
    throw new CliError(`The issue writer failed (${detail.slice(0, 500)}). Drop the draft with ${drop}.`);
  }
  if (turn.status === "invalid") {
    throw new CliError(
      [
        "The issue writer's draft was rejected twice:",
        ...turn.problems.map((p) => `- ${p}`),
        `Fix ${fileRef} and create it with \`factory new --approve ${id}\`, or drop it with ${drop}.`,
      ].join("\n"),
    );
  }

  const draft = parseDraft(readFileSync(file, "utf8"));
  const mode = config.gates.issue_writer;
  const gate = resolveGate({ mode, agentDecision: { decision: draft.decision, reasons: draft.reasons }, hardRuleHits: [], unsafe: false });
  if (gate.outcome === "proceed") return describePublished(publish(ctx, id, deps), style);

  return [
    readFileSync(file, "utf8").trim(),
    "",
    `Draft ${style.detail(id)} ${style.attention("is waiting for you")}: ${gate.reasons.join("; ")}`,
    style.hint(`Edit ${fileRef} if you like, then create it with \`factory new --approve ${id}\`, or drop it with ${drop}.`),
  ].join("\n");
}

function publish(ctx: ProjectContext, ref: string, deps: NewDeps): PublishedDraft {
  const { root, store, project } = ctx;
  try {
    return publishDraft({ root, store, project, github: deps.github ?? ghPort(project, deps.run), run: deps.run, ref });
  } catch (err) {
    if (err instanceof VerdictParseError) {
      throw new CliError([`Draft ${ref} is not valid:`, ...err.problems.map((p) => `- ${p}`), "Fix it and approve it again, or discard it."].join("\n"));
    }
    if (err instanceof DraftError) throw new CliError(err.message);
    // Whatever was created is recorded in the draft folder, so approving again only does the rest.
    throw new CliError(`${(err as Error).message}\nApprove it again to finish; issues already created are not created twice.`);
  }
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
  return describePublished(publish(ctx, ref, deps), deps.style ?? plain);
}

function discard(ctx: ProjectContext, ref: string): string {
  let entry: DraftEntry;
  try {
    entry = discardDraft(ctx.root, ref);
  } catch (err) {
    if (err instanceof DraftError) throw new CliError(err.message);
    throw err;
  }
  const kept = entry.created.length ? ` Issues already created from it stay on GitHub: ${entry.created.map((n) => `#${n}`).join(", ")}.` : "";
  return `Discarded ${entry.id}.${kept}`;
}

function listPending(ctx: ProjectContext, style: Style): string {
  const drafts = listDrafts(ctx.root);
  if (drafts.length === 0) return 'No pending drafts. Start one with `factory new "<idea>"`.';
  const width = Math.max(...drafts.map((d) => d.id.length));
  return drafts
    .map((d) => {
      const id = style.detail(d.id) + " ".repeat(width - d.id.length);
      if (!d.draft) return `${id}  ${style.attention("(invalid)")} ${d.idea}  ${style.detail(d.problems[0] ?? "")}`;
      const subs = d.draft.subIssues.length ? ` (+${d.draft.subIssues.length} sub-issues)` : "";
      const escalated = d.draft.decision === "ESCALATE" ? ` ${style.attention("(escalated)")}` : "";
      return `${id}  ${d.draft.issue.title}${subs}${escalated}`;
    })
    .join("\n");
}
