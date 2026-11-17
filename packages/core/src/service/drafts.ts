import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { VerdictParseError } from "@factory/shared";
import { createAgentRunner } from "../agents/runner.js";
import { loadTrustedConfig, trustedReader } from "../config/trusted.js";
import { parseDraft, type IssueDraft } from "../drafts/draft.js";
import {
  approvableDraft,
  discardDraft,
  DraftError,
  editDraft,
  listDrafts,
  publishDraft,
  writeDraft,
  type DraftContext,
  type DraftEdit,
  type DraftEntry,
  type PublishedDraft,
} from "../drafts/writer.js";
import { offeredLabels } from "../drafts/labels.js";
import type { FactoryEvents } from "../events.js";
import { ghPort, type IssueWriterPort, type RepoLabel } from "../github/port.js";
import { ensureGitignore } from "../init/init.js";
import { resolveGate } from "../pipeline/gates.js";
import type { CommandRunner } from "../util/exec.js";
import { ServiceError } from "./errors.js";
import type { ServiceContext } from "./runs.js";

export interface DraftDeps {
  run?: CommandRunner;
  github?: IssueWriterPort;
  /** Told the draft's text right before it is created on GitHub, so it can be shown in full first. */
  onCreate?: (text: string) => void;
  /** Queue the buildable issues once they are created. Off by default. */
  queue?: boolean;
}

function draftContext(ctx: ServiceContext, run?: CommandRunner): DraftContext {
  return { root: ctx.project.repo_path, store: ctx.store, project: ctx.project, run };
}

/** Repos set up before drafts existed: keep them out of git the way `factory init` does. Returns what was added. */
export function ensureDraftsIgnored(ctx: ServiceContext): string[] {
  return ensureGitignore(ctx.project.repo_path, [".factory/drafts/"]);
}

export type DraftOutcome =
  /** The issue writer gate lets it through: create it with approveDraft. */
  | { kind: "ready"; id: string }
  /** The issue writer gate wants a human: the draft as written, and why it waits. */
  | { kind: "waiting"; id: string; file: string; text: string; reasons: string[] };

/**
 * Draft an issue from an idea with the issue writer, and say whether `gates.issue_writer` lets it
 * be created now. Creating it is a separate step (approveDraft), so `signal` covers only the agent:
 * stopping must not interrupt half-way through creating issues on GitHub.
 */
export async function draftIssue(
  ctx: ServiceContext,
  idea: string,
  deps: {
    run?: CommandRunner;
    env?: NodeJS.ProcessEnv;
    /** Where the repository's labels come from; ghPort by default. */
    github?: IssueWriterPort;
    events?: FactoryEvents;
    signal?: AbortSignal;
    /** Told the draft's id as soon as its folder exists, while the issue writer still works. */
    onStart?: (id: string) => void;
    /** The idea was given with --queue: the hint to approve it carries that on, as the draft does not keep it. */
    queue?: boolean;
  },
): Promise<DraftOutcome> {
  const root = ctx.project.repo_path;
  // The gate, the model and the prompt steer an agent, so they come from the default branch.
  const defaultBranch = ctx.config.project.default_branch;
  const read = trustedReader(root, defaultBranch, deps.run);
  const config = loadTrustedConfig(read, defaultBranch);
  const runAgent = createAgentRunner({ events: deps.events, env: deps.env });
  // Read live: one call next to minutes of agent work, and never stale. Labels are a nicety, so a
  // failure leaves them out rather than stopping the draft.
  let labels: RepoLabel[] | undefined;
  let labelsTrouble: string | undefined;
  try {
    labels = offeredLabels((deps.github ?? ghPort(ctx.project, deps.run)).listLabels(), config.github.label_prefix);
  } catch (err) {
    labelsTrouble = `Could not read the repository's labels, so the draft gets none: ${(err as Error).message}`;
  }
  // After onStart: a listener may keep a draft's events only once it knows the draft's id.
  const onStart = (id: string) => {
    deps.onStart?.(id);
    if (labelsTrouble) deps.events?.emit({ type: "info", runId: id, message: labelsTrouble });
  };
  const written = await writeDraft({ root, config, read, runAgent, idea, labels, signal: deps.signal, onStart });

  const { id, file, turn } = written;
  const fileRef = relative(root, file);
  const drop = `\`factory new --discard ${id}\``;
  if (turn.status === "failed") {
    const { outcome } = turn.agent;
    if (outcome.kind === "rate_limited") {
      throw new ServiceError(`Usage limit reached${outcome.resetsAt ? ` (resets ${outcome.resetsAt})` : ""}. Drop the empty draft with ${drop} and try again after that.`);
    }
    const detail = outcome.kind === "error" ? `${outcome.subtype}: ${outcome.message}` : outcome.kind;
    throw new ServiceError(`The issue writer failed (${detail.slice(0, 500)}). Drop the draft with ${drop}.`);
  }
  if (turn.status === "invalid") {
    throw new ServiceError(
      [
        "The issue writer's draft was rejected twice:",
        ...turn.problems.map((p) => `- ${p}`),
        existsSync(file)
          ? `Fix ${fileRef} and create it with \`factory new --approve ${id}${deps.queue ? " --queue" : ""}\`, or drop it with ${drop}.`
          : `The last attempt wrote no draft file. Drop it with ${drop} and try again.`,
      ].join("\n"),
    );
  }

  const draft = parseDraft(readFileSync(file, "utf8"));
  const mode = config.gates.issue_writer;
  const gate = resolveGate({ mode, agentDecision: { decision: draft.decision, reasons: draft.reasons }, hardRuleHits: [], unsafe: false });
  if (gate.outcome === "proceed") return { kind: "ready", id };
  return { kind: "waiting", id, file, text: readFileSync(file, "utf8"), reasons: gate.reasons };
}

/**
 * Create a draft on GitHub. onCreate sees its text first, whatever the gate: it becomes a trusted
 * issue, so what is about to be created should always be on screen.
 */
export function approveDraft(ctx: ServiceContext, ref: string, deps: DraftDeps = {}): PublishedDraft {
  const draftCtx = draftContext(ctx, deps.run);
  try {
    const entry = approvableDraft(draftCtx, ref);
    deps.onCreate?.(readFileSync(entry.file, "utf8"));
    // Which labels are the factory's own is set on the default branch, like the prompt that picks them.
    const defaultBranch = ctx.config.project.default_branch;
    const statusLabelPrefix = loadTrustedConfig(trustedReader(ctx.project.repo_path, defaultBranch, deps.run), defaultBranch).github.label_prefix;
    return publishDraft({ ...draftCtx, github: deps.github ?? ghPort(ctx.project, deps.run), ref: entry.id, queue: deps.queue, statusLabelPrefix });
  } catch (err) {
    if (err instanceof VerdictParseError) {
      throw new ServiceError([`Draft ${ref} is not valid:`, ...err.problems.map((p) => `- ${p}`), "Fix it and approve it again, or discard it."].join("\n"));
    }
    if (err instanceof DraftError) throw new ServiceError(err.message);
    // What was created is recorded in the store, so approving again only does the rest.
    // Queuing comes with each approval, so a retry without it would leave the issues unqueued.
    throw new ServiceError(`${(err as Error).message}\nApprove it again${deps.queue ? " with --queue" : ""} to finish; issues recorded as created are not created again.`);
  }
}

/**
 * Save an edited draft, as a hand edit of its file would, but validated first: an invalid edit is
 * refused with the problems approving it would report, and the file stays as it was.
 */
export function saveDraft(ctx: ServiceContext, ref: string, edit: DraftEdit, run?: CommandRunner): DraftEntry & { draft: IssueDraft } {
  try {
    return editDraft(draftContext(ctx, run), ref, edit);
  } catch (err) {
    if (err instanceof VerdictParseError) {
      throw new ServiceError([`Draft ${ref} is not valid:`, ...err.problems.map((p) => `- ${p}`), "Nothing was saved. Fix it and save it again, or discard it."].join("\n"));
    }
    if (err instanceof DraftError) throw new ServiceError(err.message);
    throw err;
  }
}

/** Drop a pending draft. Issues already created from it (an interrupted approval) stay on GitHub. */
export function discardPendingDraft(ctx: ServiceContext, ref: string, run?: CommandRunner): DraftEntry {
  try {
    return discardDraft(draftContext(ctx, run), ref);
  } catch (err) {
    if (err instanceof DraftError) throw new ServiceError(err.message);
    throw err;
  }
}

/** Drafts not created on GitHub yet, oldest first. */
export function pendingDrafts(ctx: ServiceContext, run?: CommandRunner): DraftEntry[] {
  return listDrafts(draftContext(ctx, run));
}
