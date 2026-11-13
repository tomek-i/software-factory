import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CapturePlan, FactoryConfig } from "@factory/shared";
import { WORKTREES_DIR } from "../git/worktrees.js";
import { uploadAttachments } from "../github/attachments.js";
import { deleteMedia, publishMedia, type PublishedMedia } from "../github/media.js";
import type { Project } from "../store/store.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { launchBrowser, recordWalkthrough, shootPages, type Shot, type Walkthrough } from "./browser.js";
import { findNarrate, narrationScene, renderNarrated } from "./narrate.js";
import { appUrl, freePort, startApp, type AppServer } from "./server.js";

export type { Shot, Walkthrough } from "./browser.js";

export interface CaptureRequest {
  runId: string;
  /** The repository root, where the temporary before worktree is added. */
  root: string;
  /** The run's worktree: the "after". */
  worktreePath: string;
  defaultBranch: string;
  app: FactoryConfig["app"] & { start: string };
  plan: CapturePlan;
  /** `round-N/capture/`: screenshots, the video and the servers' logs. Never inside a worktree. */
  outDir: string;
  /** Ports to try first (the run's port block). */
  ports: number[];
  signal?: AbortSignal;
}

export interface PageCapture {
  name: string;
  path: string;
  screen: "new" | "existing";
  after: Shot[];
  /** Missing for new screens, or when the before app could not be shot (see `beforeProblem`). */
  before?: Shot[];
}

export interface CaptureResult {
  /** `skipped`: nothing could be tried (no Playwright); `failed`: the after app could not be shot. */
  status: "captured" | "skipped" | "failed";
  /** Why it was skipped or failed. */
  problem?: string;
  pages: PageCapture[];
  walkthrough?: Walkthrough;
  /** Why there are no before shots although existing screens changed. */
  beforeProblem?: string;
  /** For the PR and the report: e.g. which screens have no before shot. Engine-worded only. */
  notes: string[];
  /** For the report only (they may hold local paths and tool output): e.g. a temporary worktree left behind. */
  warnings?: string[];
}

/** Screenshots, the walkthrough and their upload. Faked in the driver tests, which have no browser. */
export interface CapturePort {
  /** Never throws for an app or browser problem: those come back as `failed`/`skipped` with the reason. */
  capture(request: CaptureRequest): Promise<CaptureResult>;
  /** Put the files where PR `prNumber` can show them, and say where they went. Throws on failure. */
  publish(runId: string, prNumber: number | null, files: string[], signal?: AbortSignal): Promise<PublishedMedia>;
  /** Delete the run's draft release (see publish's fallback). Throws when that fails. */
  discard(runId: string): void;
}

/** The real thing: Playwright for the browser, PR attachments (or a draft release) for the media. */
export function playwrightCapture(project: Project, run: CommandRunner = runCommand): CapturePort {
  return {
    capture: (request) => captureWithPlaywright(request, run),
    publish: (runId, prNumber, files, signal) => publishMedia(project, runId, prNumber, files, (repo, pr, f, s) => uploadAttachments(repo, pr, f, { signal: s }), run, signal),
    discard: (runId) => deleteMedia(project, runId, run),
  };
}

async function captureWithPlaywright(request: CaptureRequest, run: CommandRunner): Promise<CaptureResult> {
  const { plan, outDir } = request;
  const notes: string[] = [];
  const launched = await launchBrowser();
  if ("problem" in launched) return { status: "skipped", problem: launched.problem, pages: [], notes };
  const { browser } = launched;
  try {
    mkdirSync(outDir, { recursive: true });
    let pages: PageCapture[] = [];
    let walkthrough: Walkthrough | undefined;
    // After: the run's worktree, which passed the gate and the reviews.
    const after = await withApp(request, request.worktreePath, "after", async (server) => {
      const shots = await shootPages(browser, server.url, plan.pages, outDir, "after");
      pages = plan.pages.map((p) => ({ name: p.name, path: p.path, screen: p.screen, after: shots.get(p.name) ?? [] }));
      if (plan.walkthrough.length) {
        walkthrough = await recordWalkthrough(browser, server.url, plan.walkthrough, outDir);
        await narrate(request, server.url, walkthrough, run);
      }
    });
    if (after) return { status: "failed", problem: after, pages: [], notes };
    // Cancelled while the after app ran: do not start another one.
    if (request.signal?.aborted) return { status: "failed", problem: "capture was cancelled", pages: [], notes };

    // Before: only existing screens have something to compare with.
    const existing = plan.pages.filter((p) => p.screen === "existing");
    for (const p of plan.pages) if (p.screen === "new") notes.push(`no before shot of ${p.name} (${p.path}): it is a new screen`);
    let beforeProblem: string | undefined;
    const warnings: string[] = [];
    if (existing.length) {
      beforeProblem = await withBeforeWorktree(request, run, warnings, (path) =>
        withApp(request, path, "before", async (server) => {
          const shots = await shootPages(browser, server.url, existing, outDir, "before");
          for (const page of pages) if (shots.has(page.name)) page.before = shots.get(page.name);
        }),
      );
    }
    return { status: "captured", pages, walkthrough, beforeProblem, notes, ...(warnings.length ? { warnings } : {}) };
  } finally {
    await browser.close();
  }
}

/**
 * Record the walkthrough again with a voice, while the after app still runs. Only after the silent
 * run went through every step: steps that failed there would fail narrate's recording too, after
 * the narration was already spoken (and, with a cloud voice, paid for).
 */
async function narrate(request: CaptureRequest, baseUrl: string, walkthrough: Walkthrough, run: CommandRunner): Promise<void> {
  const scene = narrationScene(request.plan.walkthrough, baseUrl);
  if (!scene) return;
  const cli = findNarrate(request.app.narrate);
  if (!cli) {
    // Without the plugin the silent video is the normal case; only a configured path that is wrong is news.
    if (request.app.narrate !== "off" && request.app.narrate !== "auto") walkthrough.narrationProblem = "narrate was not found at the path in app.narrate";
    return;
  }
  if (walkthrough.problem || !walkthrough.video) {
    walkthrough.narrationProblem = "not narrated, as the silent walkthrough did not finish";
    return;
  }
  const result = await renderNarrated({ narrate: cli, scene, outDir: request.outDir, signal: request.signal, run });
  if ("video" in result) walkthrough.narrated = result.video;
  else walkthrough.narrationProblem = result.problem;
}

/**
 * Start the app in `cwd`, run `use`, and stop the app again whatever happens, including a cancel
 * (the signal stops the server at once; the browser work then fails fast). Returns why the app
 * could not be used, or undefined.
 */
async function withApp(request: CaptureRequest, cwd: string, label: string, use: (server: AppServer) => Promise<void>): Promise<string | undefined> {
  const port = await freePort(request.ports);
  let server: AppServer;
  try {
    server = await startApp({
      command: request.app.start,
      cwd,
      port,
      portEnv: request.app.port_env,
      passEnv: request.app.env,
      url: appUrl(request.app.url, port),
      logFile: join(request.outDir, `server-${label}.log`),
      timeoutMs: request.app.ready_timeout_sec * 1000,
      signal: request.signal,
    });
  } catch (err) {
    return `the app did not start (${label}): ${(err as Error).message}`;
  }
  const onAbort = () => void server.stop();
  request.signal?.addEventListener("abort", onAbort);
  try {
    await use(server);
    return undefined;
  } catch (err) {
    return `capturing the ${label} app failed: ${(err as Error).message.split("\n")[0]}`;
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
    await server.stop();
  }
}

/**
 * A temporary detached worktree of the freshly fetched default branch, removed again afterwards
 * (a removal that fails is added to `warnings`, so a leftover folder is not a surprise). Returns why
 * the before shots could not be taken, or undefined.
 */
async function withBeforeWorktree(
  request: CaptureRequest,
  run: CommandRunner,
  warnings: string[],
  use: (path: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const { root, defaultBranch } = request;
  const path = join(root, WORKTREES_DIR, `${request.runId}-before`);
  const git = (args: string[]) => run("git", args, { cwd: root });
  const remove = () => {
    const removed = git(["worktree", "remove", "--force", path]);
    git(["worktree", "prune"]);
    if (removed.code !== 0) warnings.push(`could not remove the temporary worktree ${path}: ${removed.stderr || removed.stdout}`);
  };
  // A leftover from a run that was killed mid-capture.
  if (existsSync(path)) remove();
  const fetched = git(["fetch", "--quiet", "origin", defaultBranch]);
  if (fetched.code !== 0) return `could not fetch origin/${defaultBranch} for the before shots: ${fetched.stderr}`;
  const added = git(["-c", "core.longpaths=true", "worktree", "add", "--quiet", "--detach", path, `origin/${defaultBranch}`]);
  if (added.code !== 0) return `could not check out origin/${defaultBranch} for the before shots: ${added.stderr}`;
  try {
    return await use(path);
  } finally {
    remove();
  }
}
