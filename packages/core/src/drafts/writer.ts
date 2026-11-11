import { randomUUID } from "node:crypto";
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
import { issueBody, parseDraft, parseIssueBlocks, type IssueDraft } from "./draft.js";

/** Drafts live here until they are created or discarded: there is no issue or run for them yet. */
export const DRAFTS_DIR = join(".factory", "drafts");
/** The agent's output, which the operator may edit before approving it. */
export const DRAFT_FILE = "draft.md";
const IDEA_FILE = "idea.md";
/** What has been created on GitHub so far, so an interrupted approval resumes instead of duplicating. */
const PROGRESS_FILE = "created.json";

interface Progress {
  /** GitHub number per issue: the single issue or parent first, then the sub-issues in order. */
  numbers: number[];
  /** Sub-issues already linked to the parent. */
  linked: number[];
  done: boolean;
}

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
  const files = writeRoleFiles(
    dir,
    "issue_writer",
    rolePrompt("issue_writer", read),
    permissionProfile("issue_writer", { runDirFromCwd: relative(root, dir), outputFile: file }),
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
  /** GitHub numbers already created from it. */
  created: number[];
}

function readProgress(dir: string): Progress {
  const path = join(dir, PROGRESS_FILE);
  if (!existsSync(path)) return { numbers: [], linked: [], done: false };
  return JSON.parse(readFileSync(path, "utf8")) as Progress;
}

function writeProgress(dir: string, progress: Progress): void {
  writeFileSync(join(dir, PROGRESS_FILE), JSON.stringify(progress, null, 2) + "\n");
}

function readEntry(root: string, id: string): DraftEntry {
  const dir = join(root, DRAFTS_DIR, id);
  const file = join(dir, DRAFT_FILE);
  const ideaPath = join(dir, IDEA_FILE);
  const entry: DraftEntry = {
    id,
    dir,
    file,
    idea: existsSync(ideaPath) ? readFileSync(ideaPath, "utf8").trim() : "",
    // idea.md is written once, when the draft starts.
    createdAt: statSync(existsSync(ideaPath) ? ideaPath : dir).mtime,
    problems: [],
    created: readProgress(dir).numbers,
  };
  if (!existsSync(file)) return { ...entry, problems: ["the issue writer did not write a draft"] };
  try {
    return { ...entry, draft: parseDraft(readFileSync(file, "utf8")) };
  } catch (err) {
    if (err instanceof VerdictParseError) return { ...entry, problems: err.problems };
    throw err;
  }
}

/** Drafts not created on GitHub yet, oldest first. */
export function listDrafts(root: string): DraftEntry[] {
  const base = join(root, DRAFTS_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("draft-") && !readProgress(join(base, d.name)).done)
    .map((d) => readEntry(root, d.name))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export class DraftError extends Error {}

/** A pending draft by id or unique id prefix. Only names that exist are matched, so a ref is never a path. */
export function findDraft(root: string, ref: string): DraftEntry {
  const drafts = listDrafts(root);
  const exact = drafts.find((d) => d.id === ref);
  if (exact) return exact;
  const matches = drafts.filter((d) => d.id.startsWith(ref));
  if (matches.length === 1) return matches[0]!;
  throw new DraftError(matches.length ? `"${ref}" matches several drafts; use more of the id.` : `No pending draft "${ref}". See \`factory new --list\`.`);
}

/** Drop a draft. Issues already created from it (an interrupted approval) stay on GitHub. */
export function discardDraft(root: string, ref: string): DraftEntry {
  const entry = findDraft(root, ref);
  rmSync(entry.dir, { recursive: true, force: true });
  return entry;
}

export interface PublishOptions {
  root: string;
  store: Store;
  project: Project;
  github: IssueWriterPort;
  run?: CommandRunner;
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

/**
 * Open a draft's issues on GitHub, link the sub-issues to the parent, then sync them into the store,
 * mark them as created by the factory (so they count as trusted) and queue the buildable ones.
 * The file is read and validated again first: the operator may have edited it. Each step is
 * recorded as it happens, so after a failure the next attempt continues where this one stopped.
 */
export function publishDraft(options: PublishOptions): PublishedDraft {
  const { store, project, github } = options;
  const run = options.run ?? runCommand;
  const entry = findDraft(options.root, options.ref);
  if (!entry.draft) throw new VerdictParseError(`draft ${entry.id} is not valid`, entry.problems);
  const { draft } = entry;
  const all = [draft.issue, ...draft.subIssues];
  const progress = readProgress(entry.dir);
  if (progress.numbers.length > all.length) {
    throw new DraftError(`draft ${entry.id} now has fewer issues than were already created (${progress.numbers.map((n) => `#${n}`).join(", ")})`);
  }

  all.forEach((issue, i) => {
    if (progress.numbers[i] !== undefined) return;
    // Sub-issue positions are 1-based; they were created before this one, so their numbers are known.
    const needs = issue.dependsOn.map((position) => progress.numbers[position]!);
    progress.numbers[i] = github.createIssue({ title: issue.title, body: issueBody(issue, needs) });
    writeProgress(entry.dir, progress);
  });
  const [parent, ...children] = progress.numbers as [number, ...number[]];
  for (const child of children) {
    if (progress.linked.includes(child)) continue;
    github.addSubIssue(parent, child);
    progress.linked.push(child);
    writeProgress(entry.dir, progress);
  }

  for (const number of progress.numbers) {
    fetchIssue(store, project, number, run);
    store.markCreatedByFactory(project.id, number);
  }
  const queued = children.length ? children : [parent];
  for (const number of queued) store.setQueued(project.id, number, true);
  progress.done = true;
  writeProgress(entry.dir, progress);

  return {
    id: entry.id,
    issue: { number: parent, title: draft.issue.title },
    subIssues: children.map((number, i) => ({ number, title: draft.subIssues[i]!.title })),
    queued,
  };
}
