import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { loadPlaywright } from "../capture/browser.js";

/**
 * Uploads files as GitHub PR attachments (`github.com/user-attachments/...`), the way dragging them
 * into a comment box does. GitHub has no API for these, so a browser signed in to GitHub (its own
 * profile, see `githubProfileDir`) does it on the PR page; the comment is never posted.
 *
 * Unlike a draft release, attachments are served to whoever can see the repo: everyone for a public
 * repo, only people with access for a private one. Videos play inline in the PR.
 */

/** A link GitHub puts in the comment box once an upload finished. */
const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[\w.-]+(?:\/[\w.-]+)?/g;

const IMAGE_LIMIT = 10 * 1024 * 1024;
// 10 MB on free plans; GitHub refuses a larger one, which only costs the wait below.
const VIDEO_LIMIT = 100 * 1024 * 1024;
const VIDEO = new Set([".mp4", ".mov", ".webm"]);
const UPLOAD_TIMEOUT_MS = 60_000;

/** No GitHub user is signed in to the factory's browser profile. */
export class NotSignedInError extends Error {
  constructor() {
    super("the factory's browser is not signed in to GitHub: run `factory login github`");
    this.name = "NotSignedInError";
  }
}

/**
 * Where the factory's GitHub browser profile lives: per user, never in a repository, since it holds
 * a GitHub session. `%LOCALAPPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere.
 */
export function githubProfileDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const base = platform === "win32" ? (env.LOCALAPPDATA ?? join(home, "AppData", "Local")) : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(base, "software-factory", "github-browser");
}

/** The first attachment link in the comment box that is not in `seen`: a late one belongs to an earlier file. */
export function newAttachmentLink(text: string, seen: ReadonlySet<string>): string | undefined {
  return [...text.matchAll(ATTACHMENT)].map((m) => m[0]).find((url) => !seen.has(url));
}

/** Why GitHub would refuse the file, before waiting a minute to find out. */
export function attachmentProblem(file: string, size: number): string | undefined {
  const video = VIDEO.has(extname(file).toLowerCase());
  const limit = video ? VIDEO_LIMIT : IMAGE_LIMIT;
  if (size > limit) return `${basename(file)} is ${(size / 1024 / 1024).toFixed(1)} MB, over GitHub's ${limit / 1024 / 1024} MB limit for ${video ? "videos" : "images"}`;
  return undefined;
}

/**
 * Attaching failed. `message` is safe to show in a public PR: a fixed reason, never a path or a
 * browser log. `detail` is the underlying error, for the run's report only.
 */
export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Why Chromium would not open the profile, as a reason fit for a PR. */
export function launchProblem(err: unknown): AttachmentError {
  const detail = (err as Error).message;
  // Chromium locks a profile while one browser uses it.
  if (/ProcessSingleton|SingletonLock|profile (directory )?(appears to be )?in use|user data directory is already in use/i.test(detail)) {
    return new AttachmentError("the factory's browser profile is in use (another upload, or `factory login github` is open)", detail);
  }
  return new AttachmentError("the factory's browser could not start", detail);
}

export interface BrowserOptions {
  /** The profile directory; defaults to `githubProfileDir()`. */
  profile?: string;
  /** Defaults to https://github.com; tests point it at a local page. */
  baseUrl?: string;
  /** How long to wait for each file's link. */
  timeoutMs?: number;
  /** Closes the browser and stops: the run was cancelled or the worker is going away. */
  signal?: AbortSignal;
}

async function openProfile(profile: string, headless: boolean): Promise<BrowserContext> {
  let chromium: Awaited<ReturnType<typeof loadPlaywright>>["chromium"];
  try {
    ({ chromium } = await loadPlaywright());
  } catch (err) {
    throw new AttachmentError("Playwright is not installed", (err as Error).message);
  }
  try {
    return await chromium.launchPersistentContext(profile, { headless, viewport: headless ? { width: 1280, height: 900 } : null });
  } catch (err) {
    throw launchProblem(err);
  }
}

/** The signed-in user's login, from the meta tag GitHub puts on every page; "" when nobody is. */
async function signedInUser(page: Page): Promise<string> {
  return (await page.locator('meta[name="user-login"]').getAttribute("content", { timeout: 5000 }).catch(() => null)) ?? "";
}

// One browser at a time may use the profile, so uploads of runs in this process wait for each other.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Upload each file as an attachment on PR `prNumber` of `repo` and return its link, by file name.
 * Throws NotSignedInError when the profile has no GitHub session, and an AttachmentError when a
 * file is too big, the browser cannot start, the page is not what it expects, a link does not come
 * back in time or `signal` aborts. Files uploaded before a failure stay on GitHub, unlinked.
 */
export function uploadAttachments(repo: string, prNumber: number, files: string[], options: BrowserOptions = {}): Promise<Record<string, string>> {
  const turn = queue.then(() => upload(repo, prNumber, files, options));
  queue = turn.catch(() => undefined);
  return turn;
}

async function upload(repo: string, prNumber: number, files: string[], options: BrowserOptions): Promise<Record<string, string>> {
  const stopped = () => new AttachmentError("the run stopped while the media was uploading");
  for (const file of files) {
    const problem = attachmentProblem(file, statSync(file).size);
    if (problem) throw new AttachmentError(problem);
  }
  if (options.signal?.aborted) throw stopped();
  const base = options.baseUrl ?? "https://github.com";
  const context = await openProfile(options.profile ?? githubProfileDir(), true);
  const abort = () => void context.close().catch(() => undefined);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${base}/${repo}/pull/${prNumber}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!(await signedInUser(page))) throw new NotSignedInError();
    const box = page.locator('textarea[name="comment[body]"]').last();
    await box.waitFor({ timeout: 30_000 });
    // A fresh page's box takes no file until its editor has initialised.
    await box.click();
    await page.waitForTimeout(1500);
    const input = page.locator('form:has(textarea[name="comment[body]"]) input[type="file"]').last();
    const links: Record<string, string> = {};
    const seen = new Set<string>();
    try {
      for (const file of files) {
        await box.fill("");
        await input.setInputFiles(file);
        const until = Date.now() + (options.timeoutMs ?? UPLOAD_TIMEOUT_MS);
        let url: string | undefined;
        while (!url && Date.now() < until) {
          await page.waitForTimeout(500);
          url = newAttachmentLink(await box.inputValue(), seen);
        }
        if (!url) throw new AttachmentError(`no attachment link came back for ${basename(file)} in time`);
        seen.add(url);
        links[basename(file)] = url;
      }
    } finally {
      // Nothing may stay in the box: GitHub keeps an unsent comment as a draft.
      await box.fill("").catch(() => undefined);
    }
    return links;
  } catch (err) {
    if (options.signal?.aborted) throw stopped();
    if (err instanceof AttachmentError || err instanceof NotSignedInError) throw err;
    // Playwright's messages name selectors, URLs and local paths: none of that goes to the PR.
    throw new AttachmentError("GitHub's PR page did not work as expected", (err as Error).message);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await context.close().catch(() => undefined);
  }
}

/**
 * `factory login github`: open the profile in a visible browser and wait until someone has signed in
 * to GitHub there (up to `waitMs`). Returns the login; throws NotSignedInError when nobody did.
 */
export async function loginGithub(options: BrowserOptions & { waitMs?: number; onWaiting?: () => void } = {}): Promise<string> {
  const base = options.baseUrl ?? "https://github.com";
  const context = await openProfile(options.profile ?? githubProfileDir(), false);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${base}/login`);
    let user = await signedInUser(page);
    if (!user) options.onWaiting?.();
    const until = Date.now() + (options.waitMs ?? 15 * 60_000);
    // Closing the window ends the wait.
    while (!user && Date.now() < until && !page.isClosed()) {
      await page.waitForTimeout(2000).catch(() => undefined);
      user = await signedInUser(page);
    }
    if (!user) throw new NotSignedInError();
    return user;
  } finally {
    await context.close();
  }
}
