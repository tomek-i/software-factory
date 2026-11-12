import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveModel, VerdictParseError, type FactoryConfig } from "@factory/shared";
import { permissionProfile, rolePrompt, writeRoleFiles } from "../agents/prompts.js";
import type { AgentRunner } from "../agents/runner.js";
import { runTurn, type TurnResult } from "../agents/turn.js";
import type { TrustedReader } from "../config/trusted.js";
import { fetchIssue } from "../github/issues.js";
import type { IssueWriterPort } from "../github/port.js";
import type { Project, Store } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { issueBody, parseDraft, parseIssueBlocks, type DraftIssue, type IssueDraft } from "./draft.js";

/** Drafts live here until they are created or discarded: there is no issue or run for them yet. */
export const DRAFTS_DIR = join(".factory", "drafts");
/** The agent's output, which the operator may edit before approving it. */
export const DRAFT_FILE = "draft.md";
const IDEA_FILE = "idea.md";

export interface WriteDraftOptions {
  root: string;
  /** From the default branch, like everything that steers an agent. */
  config: FactoryConfig;
  read: TrustedReader;
  runAgent: AgentRunner;
  idea: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WrittenDraft {
  id: string;
  dir: string;
  file: string;
  turn: TurnResult<"issue_writer">;
}

/** The task for the issue writer: the idea is the operator's own words, so it is the request. */
function ideaTask(id: string, root: string, outputFile: string, idea: string, lessons: string | undefined): string {
  const parts = [
    "# Task: issue_writer",
    "",
    `Draft: ${id}`,
    `Working directory: \`${root}\``,
    `Output file: \`${outputFile}\``,
  ];
  if (lessons?.trim()) parts.push("", "## Lessons from earlier runs", lessons.trim());
  parts.push(
    "",
    "## Idea",
    "From the factory's operator, a trusted author. This is the request to work on.",
    "",
    idea.trim(),
    "",
    "## Now",
    "Read the repository where the idea touches it, then write the draft to the output file.",
    "",
  );
  return parts.join("\n");
}

/**
 * Run the issue writer on an idea in a new draft folder. The agent reads the repo and may write only
 * the draft; a malformed draft gets one retry, like every other agent turn.
 */
export async function writeDraft(options: WriteDraftOptions): Promise<WrittenDraft> {
  const { root, config, read } = options;
  const id = `draft-${randomUUID().slice(0, 8)}`;
  const dir = join(root, DRAFTS_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, IDEA_FILE), `${options.idea.trim()}\n`);
  const file = join(dir, DRAFT_FILE);
  // Other drafts may hold anything (a hand edit, a planted file); this one starts from the idea alone.
  const otherDrafts = readdirSync(join(root, DRAFTS_DIR), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== id)
    .map((d) => relative(root, join(root, DRAFTS_DIR, d.name)));
  const files = writeRoleFiles(
    dir,
    "issue_writer",
    rolePrompt("issue_writer", read),
    permissionProfile("issue_writer", { runDirFromCwd: relative(root, dir), outputFile: file, denyRead: otherDrafts }),
  );
  const turn = await runTurn({
    run: options.runAgent,
    kind: "issue_writer",
    outputFile: file,
    agent: {
      runId: id,
      role: "issue_writer",
      ...resolveModel(config, { role: "issue_writer" }),
      cwd: root,
      logDir: join(dir, "logs"),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 20 * 60_000,
      ...files,
      prompt: ideaTask(id, root, file, options.idea, read(".factory/lessons.md")),
    },
    validate: (verdict) => parseIssueBlocks(verdict.body).problems,
  });
  return { id, dir, file, turn };
}

/** Where drafts are looked up, and the store that remembers what was created from them. */
export interface DraftContext {
  root: string;
  store: Store;
  project: Project;
  run?: CommandRunner;
}

export interface DraftEntry {
  id: string;
  dir: string;
  file: string;
  idea: string;
  createdAt: Date;
  /** Set when the draft file parses. */
  draft?: IssueDraft;
  /** Why it does not, e.g. after a hand edit, or when the agent never wrote it. */
  problems: string[];
  /** Why it may never be created, e.g. it came from a branch rather than from `factory new`. */
  refusal?: string;
  /** GitHub numbers already created from it. */
  created: number[];
}

/**
 * Files of the draft folder that git tracks. `factory new` only ever writes ignored files there, so
 * a tracked one came from a commit, and a commit can come from anyone who can push a branch.
 */
function trackedFiles(ctx: DraftContext, dir: string): string[] {
  const run = ctx.run ?? runCommand;
  const result = run("git", ["ls-files", "--", relative(ctx.root, dir).replace(/\\/g, "/")], { cwd: ctx.root });
  if (result.code !== 0) throw new DraftError(`could not check whether git tracks ${relative(ctx.root, dir)}: ${result.stderr || "unknown error"}`);
  return result.stdout.split("\n").filter(Boolean);
}

function readEntry(ctx: DraftContext, id: string): DraftEntry {
  const dir = join(ctx.root, DRAFTS_DIR, id);
  const file = join(dir, DRAFT_FILE);
  const ideaPath = join(dir, IDEA_FILE);
  const entry: DraftEntry = {
    id,
    dir,
    file,
    idea: "",
    createdAt: statSync(dir).mtime,
    problems: [],
    created: ctx.store.listDraftIssues(ctx.project.id, id).map((r) => r.number),
  };
  // One unreadable draft must not break listing, approving or discarding the others.
  try {
    if (existsSync(ideaPath)) {
      entry.idea = readFileSync(ideaPath, "utf8").trim();
      // idea.md is written once, when the draft starts.
      entry.createdAt = statSync(ideaPath).mtime;
    }
    const tracked = trackedFiles(ctx, dir);
    if (tracked.length) {
      entry.refusal = `${tracked.join(", ")} ${tracked.length === 1 ? "is" : "are"} tracked by git, so the draft may come from someone else's commit; only drafts written by \`factory new\` on this machine can be created`;
    }
    if (!existsSync(file)) return { ...entry, problems: ["the issue writer did not write a draft"] };
    return { ...entry, draft: parseDraft(readFileSync(file, "utf8")) };
  } catch (err) {
    return { ...entry, problems: err instanceof VerdictParseError ? err.problems : [(err as Error).message] };
  }
}

/** Drafts not created on GitHub yet, oldest first. */
export function listDrafts(ctx: DraftContext): DraftEntry[] {
  const base = join(ctx.root, DRAFTS_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("draft-") && !ctx.store.isDraftFinished(ctx.project.id, d.name))
    .map((d) => readEntry(ctx, d.name))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export class DraftError extends Error {}

/** A pending draft by id or unique id prefix. Only names that exist are matched, so a ref is never a path. */
export function findDraft(ctx: DraftContext, ref: string): DraftEntry {
  const drafts = listDrafts(ctx);
  const exact = drafts.find((d) => d.id === ref);
  if (exact) return exact;
  const matches = drafts.filter((d) => d.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  throw new DraftError(matches.length ? `"${ref}" matches several drafts; use more of the id.` : `No pending draft "${ref}". See \`factory new --list\`.`);
}

/** Drop a draft. Issues already created from it (an interrupted approval) stay on GitHub. */
export function discardDraft(ctx: DraftContext, ref: string): DraftEntry {
  const entry = findDraft(ctx, ref);
  rmSync(entry.dir, { recursive: true, force: true });
  return entry;
}

/** A draft that can be created: valid, and not planted by a commit. */
export function approvableDraft(ctx: DraftContext, ref: string): DraftEntry & { draft: IssueDraft } {
  const entry = findDraft(ctx, ref);
  if (entry.refusal) throw new DraftError(`Draft ${entry.id} cannot be created: ${entry.refusal}.`);
  if (!entry.draft) throw new VerdictParseError(`draft ${entry.id} is not valid`, entry.problems);
  return entry as DraftEntry & { draft: IssueDraft };
}

export interface PublishOptions extends DraftContext {
  github: IssueWriterPort;
  ref: string;
}

export interface PublishedDraft {
  id: string;
  /** The single issue, or the parent. */
  issue: { number: number; title: string };
  subIssues: { number: number; title: string }[];
  /** Queued for the factory: the sub-issues, or the single issue; never a parent. */
  queued: number[];
}

/** Identifies a draft entry, so a number created from it is never reused for different text. */
function fingerprint(issue: DraftIssue): string {
  return createHash("sha256").update(JSON.stringify([issue.title, issue.body, issue.ui, issue.risk, issue.dependsOn])).digest("hex");
}

/**
 * Open a draft's issues on GitHub, link the sub-issues to the parent, then sync them into the store,
 * mark them as created by the factory (so they count as trusted) and queue the buildable ones.
 * The file is read and validated again first: the operator may have edited it. Each step is
 * recorded in the store as it happens, so after a failure the next attempt continues where this
 * one stopped; an entry edited after its issue was created is refused rather than matched by position.
 */
export function publishDraft(options: PublishOptions): PublishedDraft {
  const { store, project, github } = options;
  const run = options.run ?? runCommand;
  const entry = approvableDraft(options, options.ref);
  const { draft } = entry;
  const all = [draft.issue, ...draft.subIssues];
  const records = store.listDraftIssues(project.id, entry.id);
  for (const record of records) {
    const issue = all[record.position];
    if (!issue || fingerprint(issue) !== record.fingerprint) {
      const which = record.position === 0 ? "the first issue" : `sub-issue ${record.position}`;
      throw new DraftError(
        `${which} of draft ${entry.id} was already created as #${record.number} and has changed since (or is gone); undo the edit to finish creating the draft, or discard it`,
      );
    }
  }

  const numbers = records.map((r) => r.number);
  all.forEach((issue, position) => {
    if (numbers[position] !== undefined) return;
    // Sub-issue positions are 1-based; they were created before this one, so their numbers are known.
    const needs = issue.dependsOn.map((p) => numbers[p]!);
    const number = github.createIssue({ title: issue.title, body: issueBody(issue, needs) });
    store.recordDraftIssue(project.id, entry.id, { position, number, fingerprint: fingerprint(issue) });
    numbers[position] = number;
  });
  const [parent, ...children] = numbers as [number, ...number[]];
  const linked = new Set(records.filter((r) => r.linked).map((r) => r.position));
  children.forEach((child, i) => {
    if (linked.has(i + 1)) return;
    github.addSubIssue(parent, child);
    store.markDraftIssueLinked(project.id, entry.id, i + 1);
  });

  for (const number of numbers) {
    fetchIssue(store, project, number, run);
    store.markCreatedByFactory(project.id, number);
  }
  const queued = children.length ? children : [parent];
  for (const number of queued) store.setQueued(project.id, number, true);
  store.finishDraft(project.id, entry.id);

  return {
    id: entry.id,
    issue: { number: parent, title: draft.issue.title },
    subIssues: children.map((number, i) => ({ number, title: draft.subIssues[i]!.title })),
    queued,
  };
}

