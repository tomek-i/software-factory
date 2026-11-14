import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { CAPTURE_WIDTHS, MAX_STEP_WAIT_MS, type CapturePage, type WalkthroughStep } from "@factory/shared";
import { findNarrate } from "./narrate.js";

/** How to make Playwright available, for the notes when it is not. */
export const PLAYWRIGHT_HINT =
  "install playwright to enable screenshots: `pnpm install` in the factory's checkout (playwright is an optional dependency), then `pnpm exec playwright install chromium`; the narrate Claude Code plugin's own copy is used too, unless `app.narrate` is `off`";

const NAV_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 10_000;

type PlaywrightModule = typeof import("playwright");

/**
 * Playwright from the factory's own install, or else, when `app.narrate` allows it, the copy the
 * narrate plugin ships with. So the plugin saves a separate install only under `auto` or a path, and
 * only when the plugin picked ships Playwright; with `off`, or a path to a plugin without it, the
 * factory needs its own install. Throws the first error when neither loads.
 *
 * `narrate` is the `app.narrate` setting, so the plugin is only reached into when it is allowed:
 * `off` uses the factory's own Playwright alone, a path only the plugin that path belongs to, and
 * `auto` the newest plugin in Claude Code's cache.
 */
export async function loadPlaywright(narrate = "auto", home?: string): Promise<PlaywrightModule> {
  try {
    return await import("playwright");
  } catch (err) {
    const cli = findNarrate(narrate, home);
    if (!cli) throw err;
    try {
      // bin/narrate.mjs sits next to the plugin's package.json and node_modules.
      return createRequire(join(dirname(dirname(cli)), "package.json"))("playwright") as PlaywrightModule;
    } catch {
      throw err;
    }
  }
}

/**
 * Launch headless Chromium, or say why it cannot be. Playwright is an optional dependency loaded on
 * demand: without it (or its browsers) capture is skipped and the run goes on. `narrate` is the
 * `app.narrate` setting, which decides whether the plugin's copy may be used.
 */
export async function launchBrowser(narrate?: string): Promise<{ browser: Browser } | { problem: string }> {
  let chromium: PlaywrightModule["chromium"];
  try {
    ({ chromium } = await loadPlaywright(narrate));
  } catch (err) {
    return { problem: `${PLAYWRIGHT_HINT} (${(err as Error).message.split("\n")[0]})` };
  }
  try {
    return { browser: await chromium.launch({ headless: true }) };
  } catch (err) {
    const first = (err as Error).message.split("\n").find((l) => l.trim()) ?? "launch failed";
    return { problem: `could not launch Chromium; ${PLAYWRIGHT_HINT} (${first.trim()})` };
  }
}

/**
 * Whether Playwright and its Chromium are installed, without launching a browser (tests use it to
 * decide whether a real-browser test can run). There is no project config here, so `auto`.
 */
export async function chromiumInstalled(): Promise<boolean> {
  try {
    const { chromium } = await loadPlaywright();
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

/** One screenshot of one page at one width, and what went wrong on the page while it loaded. */
export interface Shot {
  width: number;
  /** Absolute path of the PNG; missing when the page could not be shot. */
  file?: string;
  /** Console errors, page errors, failed requests and 4xx/5xx responses, origin-free so before and after compare. */
  signals: string[];
  /** Why there is no screenshot. */
  error?: string;
}

/** `http://localhost:4701/x` -> `/x`, so the same error on a different port reads the same. */
function originFree(text: string, origin: string): string {
  return text.split(origin).join("");
}

/** The origin of a URL, or undefined for one without (about:blank, chrome-error://, garbage). */
function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the page is anywhere but the app: another site, or Chromium's error page after a blocked navigation. */
export function leftApp(url: string, origin: string): boolean {
  return url !== "about:blank" && originOf(url) !== origin;
}

/** Whether Playwright failed because the same-origin guard blocked where the page was going. */
function blockedByGuard(err: unknown): boolean {
  return (err as Error).message.includes("ERR_BLOCKED_BY_CLIENT");
}

const NOT_SHOT = "the page led away from the app, so it was not shot";

/** Whether a response redirects to another origin (a 3xx whose Location resolves elsewhere). */
export function redirectsAway(status: number, location: string | undefined, requestUrl: string, origin: string): boolean {
  if (status < 300 || status > 399 || !location) return false;
  try {
    return new URL(location, requestUrl).origin !== origin;
  } catch {
    return true;
  }
}

/**
 * Same-origin guard for a context: navigations of the top frame to another origin are aborted, so
 * neither a plan nor a link in the app takes the browser to another site, and a same-origin page
 * that redirects to another origin is cut off at the redirect. Other requests (fonts, CDNs) are
 * left alone; the app needs them to render. Callers still check where the page ended up (leftApp),
 * since a redirect the browser makes on its own (a meta refresh, script) never passes through here.
 */
async function sameOriginOnly(context: BrowserContext, origin: string): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (!request.isNavigationRequest() || request.frame().parentFrame() !== null) return route.continue();
    if (originOf(request.url()) !== origin) return route.abort("blockedbyclient");
    // Fetched here without following redirects, so a Location to another site never reaches the browser.
    const response = await route.fetch({ maxRedirects: 0 });
    if (redirectsAway(response.status(), response.headers()["location"], request.url(), origin)) return route.abort("blockedbyclient");
    return route.fulfill({ response });
  });
}

function watchSignals(page: Page, origin: string): string[] {
  const signals: string[] = [];
  const add = (text: string) => signals.push(originFree(text, origin).slice(0, 500));
  // URLs already reported with their HTTP status; Chromium reports the same failure up to three times.
  const answered = new Set<string>();
  page.on("console", (msg) => {
    // The browser's own echo of a failed request: the response or failure below names it with its URL.
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource:")) add(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => add(`page error: ${err.message}`));
  page.on("requestfailed", (req) => {
    // The guard's own aborts are not the app's errors.
    if (req.failure()?.errorText.includes("ERR_BLOCKED_BY_CLIENT") || answered.has(req.url())) return;
    add(`request failed: ${req.method()} ${req.url()} (${req.failure()?.errorText ?? "failed"})`);
  });
  page.on("response", (res) => {
    if (res.status() < 400) return;
    answered.add(res.url());
    add(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`);
  });
  return signals;
}

/**
 * Screenshot each page at every capture width, full page, as `<prefix>-<page>-<width>.png` in
 * `outDir`. A page that fails to load is recorded with its error; the others are still shot.
 */
export async function shootPages(browser: Browser, baseUrl: string, pages: CapturePage[], outDir: string, prefix: "before" | "after"): Promise<Map<string, Shot[]>> {
  mkdirSync(outDir, { recursive: true });
  const origin = new URL(baseUrl).origin;
  const result = new Map<string, Shot[]>();
  for (const target of pages) {
    const shots: Shot[] = [];
    for (const width of CAPTURE_WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: width >= 1000 ? 900 : 844 } });
      try {
        await sameOriginOnly(context, origin);
        const page = await context.newPage();
        const signals = watchSignals(page, origin);
        const file = join(outDir, `${prefix}-${target.name}-${width}.png`);
        try {
          await page.goto(new URL(target.path, origin).href, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
          // Let client-side rendering and late requests settle; an app that never goes idle is shot anyway.
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
          // Never shoot (and publish) anything but the app itself.
          if (leftApp(page.url(), origin)) {
            shots.push({ width, signals, error: NOT_SHOT });
            continue;
          }
          await page.screenshot({ path: file, fullPage: true });
          shots.push({ width, file, signals });
        } catch (err) {
          shots.push({ width, signals, error: blockedByGuard(err) ? NOT_SHOT : (err as Error).message.split("\n")[0] });
        }
      } finally {
        await context.close();
      }
    }
    result.set(target.name, shots);
  }
  return result;
}

export interface Walkthrough {
  /** `walkthrough.webm`, when a video was recorded. */
  video?: string;
  /** Screenshots the steps asked for. */
  screenshots: string[];
  /** Steps that ran. */
  ran: number;
  /** The same walkthrough with a voice (`walkthrough-narrated.mp4`), when the plan says something and narrate is installed. */
  narrated?: string;
  /** Why there is no narrated video although the plan asked for one. For the report and the PR. */
  narrationProblem?: string;
  /** Why the walkthrough stopped early, e.g. `step 3 (click "Save"): timeout`. */
  problem?: string;
  signals: string[];
}

function describeStep(step: WalkthroughStep): string {
  switch (step.action) {
    case "goto":
      return `goto ${step.path}`;
    case "click":
      return step.selector ? `click ${step.selector}` : `click text "${step.text}"`;
    case "fill":
      return `fill ${step.selector}`;
    case "wait":
      return `wait ${step.ms}ms`;
    case "screenshot":
      return `screenshot ${step.name}`;
  }
}

/**
 * Run the plan's walkthrough steps in a recorded browser context and save the video as
 * `walkthrough.webm`. Steps are interpreted here, one fixed action each; nothing from the plan is
 * ever evaluated as code. A failing step ends the walkthrough and is reported, never thrown.
 */
export async function recordWalkthrough(browser: Browser, baseUrl: string, steps: WalkthroughStep[], outDir: string): Promise<Walkthrough> {
  const origin = new URL(baseUrl).origin;
  const videoDir = join(outDir, "video");
  mkdirSync(videoDir, { recursive: true });
  const size = { width: 1280, height: 720 };
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: videoDir, size } });
  const out: Walkthrough = { screenshots: [], ran: 0, signals: [] };
  let page: Page | undefined;
  // Set when the guard blocked a step on its way off the app.
  let blocked = false;
  try {
    await sameOriginOnly(context, origin);
    page = await context.newPage();
    out.signals = watchSignals(page, origin);
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    // A walkthrough that starts anywhere but a page shows a blank video.
    const all: WalkthroughStep[] = steps[0]?.action === "goto" ? steps : [{ action: "goto", path: "/" }, ...steps];
    for (const [i, step] of all.entries()) {
      try {
        await runStep(page, step, origin, outDir, out);
        out.ran++;
      } catch (err) {
        blocked = blockedByGuard(err);
        out.problem = blocked ? `step ${i + 1} (${describeStep(step)}) left the app` : `step ${i + 1} (${describeStep(step)}): ${(err as Error).message.split("\n")[0]}`;
        break;
      }
      // A click or a redirect can lead off the app. The guard aborts what it sees, which leaves
      // Chromium on its error page; either way the walkthrough cannot go on from there.
      if (leftApp(page.url(), origin)) {
        out.problem = `step ${i + 1} (${describeStep(step)}) left the app`;
        break;
      }
    }
    await page.waitForTimeout(800); // so the last state is visible in the video
  } catch (err) {
    out.problem ??= (err as Error).message.split("\n")[0];
  } finally {
    // However the walkthrough ended, a page that is not the app means the video may show it.
    const left = blocked || (page !== undefined && leftApp(page.url(), origin));
    if (left) out.problem = `${out.problem ?? "the walkthrough left the app"}; the video was discarded, as it may show a page outside the app`;
    const video = page?.video();
    await context.close();
    if (video) {
      try {
        const recorded = await video.path();
        // It may show whatever was outside the app for a moment: never publish that.
        if (left) rmSync(recorded, { force: true });
        else {
          const file = join(outDir, "walkthrough.webm");
          renameSync(recorded, file);
          out.video = file;
        }
      } catch (err) {
        out.problem ??= `the video could not be saved: ${(err as Error).message}`;
      }
    }
  }
  return out;
}

async function runStep(page: Page, step: WalkthroughStep, origin: string, outDir: string, out: Walkthrough): Promise<void> {
  switch (step.action) {
    case "goto":
      await page.goto(new URL(step.path, origin).href, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      return;
    case "click":
      await (step.selector ? page.locator(step.selector) : page.getByText(step.text!, { exact: false })).first().click();
      return;
    case "fill":
      await page.locator(step.selector).first().fill(step.value);
      return;
    case "wait":
      await page.waitForTimeout(Math.min(step.ms, MAX_STEP_WAIT_MS));
      return;
    case "screenshot": {
      if (leftApp(page.url(), origin)) throw new Error("the page is no longer the app");
      const file = join(outDir, `step-${step.name}.png`);
      await page.screenshot({ path: file });
      out.screenshots.push(file);
      return;
    }
  }
}
