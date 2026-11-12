import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { WalkthroughStep } from "@factory/shared";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { killTree } from "../util/process.js";
import { APP_ENV_ALLOWLIST, track, untrack } from "./server.js";

/**
 * Narrated walkthroughs with the narrate Claude Code plugin's own CLI (`bin/narrate.mjs render`),
 * which drives headless Playwright, speaks each beat and muxes the voice in with ffmpeg. It is
 * called as a plain command, never as a plugin inside an agent: agents run without plugins or MCP
 * servers on purpose, since they read untrusted issue text.
 */

/** Rendering speaks every beat and encodes video; the plugin's own runs take a few minutes. */
const RENDER_TIMEOUT_MS = 10 * 60_000;

/**
 * Where the narrate CLI is: `off` turns it off, `auto` looks in Claude Code's plugin cache and takes
 * the newest version, anything else is a path to `narrate.mjs`. Undefined when there is none.
 */
export function findNarrate(setting: string, home = homedir()): string | undefined {
  if (setting === "off") return undefined;
  // Absolute, as narrate runs from its own folder, not the one the config was read in.
  if (setting !== "auto") return existsSync(setting) ? resolve(setting) : undefined;
  const cache = join(home, ".claude", "plugins", "cache");
  const found: { version: number[]; path: string }[] = [];
  for (const marketplace of list(cache)) {
    const plugin = join(cache, marketplace, "narrate");
    for (const version of list(plugin)) {
      const path = join(plugin, version, "bin", "narrate.mjs");
      const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      if (parsed && existsSync(path)) found.push({ version: parsed.slice(1).map(Number), path });
    }
  }
  found.sort((a, b) => compare(b.version, a.version));
  return found[0]?.path;
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

interface SceneStep {
  action: string;
  [key: string]: unknown;
}

export interface NarrationScene {
  name: string;
  site: string;
  viewport: { width: number; height: number };
  beats: { id: string; say: string; do: SceneStep[] }[];
}

/**
 * The walkthrough as a narrate scene, or undefined when no step says anything. A step with `say`
 * starts a beat; steps before the first one join it. Only the plan's own fixed actions are mapped,
 * with paths turned into URLs on the app's origin, so the scene can never hold narrate's `eval`,
 * `uploadFile` or a URL elsewhere. Screenshots were already taken by the silent run, so they drop out.
 */
export function narrationScene(steps: WalkthroughStep[], baseUrl: string): NarrationScene | undefined {
  if (!steps.some((s) => s.say)) return undefined;
  const origin = new URL(baseUrl).origin;
  const beats: NarrationScene["beats"] = [];
  let pending: SceneStep[] = [];
  for (const step of steps) {
    const mapped = sceneStep(step, origin);
    if (step.say) {
      beats.push({ id: `beat-${beats.length + 1}`, say: step.say, do: [...pending, ...(mapped ? [mapped] : [])] });
      pending = [];
    } else if (mapped) {
      (beats.at(-1)?.do ?? pending).push(mapped);
    }
  }
  return { name: "walkthrough", site: new URL("/", origin).href, viewport: { width: 1280, height: 720 }, beats };
}

function sceneStep(step: WalkthroughStep, origin: string): SceneStep | undefined {
  switch (step.action) {
    case "goto":
      return { action: "navigate", url: new URL(step.path, origin).href };
    case "click":
      // What `getByText(text)` builds, as the silent run used: a case-insensitive substring match,
      // quoted, so text holding `>>` stays text instead of becoming a selector chain.
      return { action: "click", selector: step.selector ?? `internal:text=${JSON.stringify(step.text)}i` };
    case "fill":
      // narrate replaces `${NAME}` in fill text with that environment variable; `$${` keeps it literal,
      // so a value cannot type the user's environment into a published video. (A function, as `$$` in
      // a replacement string means a single `$`.)
      return { action: "fill", selector: step.selector, text: step.value.replaceAll("${", () => "$${") };
    case "wait":
      return step.ms > 0 ? { action: "wait", ms: step.ms } : undefined;
    case "screenshot":
      return undefined;
  }
}

export interface NarrateRequest {
  /** Path to `narrate.mjs`. */
  narrate: string;
  scene: NarrationScene;
  /** `round-N/capture/`: the narrated video lands here, the scene and the log in `narrate/`. */
  outDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** For the ffmpeg check. */
  run?: CommandRunner;
}

/** The narrated video, or why there is none. Never throws. */
export async function renderNarrated(request: NarrateRequest): Promise<{ video: string } | { problem: string }> {
  const run = request.run ?? runCommand;
  if (run("ffmpeg", ["-version"], { cwd: request.outDir, timeoutMs: 30_000 }).code !== 0) {
    return { problem: "ffmpeg is not on PATH; narrate needs it to add the voice" };
  }
  // Its own folder as the working directory: narrate keeps `.narrate/` there, never in a worktree.
  const dir = join(request.outDir, "narrate");
  // A capture repeated in the same round (after a usage limit) must not pick up the last attempt's video.
  rmSync(dir, { recursive: true, force: true });
  for (const ext of ["mp4", "webm"]) rmSync(join(request.outDir, `walkthrough-narrated.${ext}`), { force: true });
  mkdirSync(dir, { recursive: true });
  const sceneFile = join(dir, "walkthrough.scene.json");
  writeFileSync(sceneFile, `${JSON.stringify(request.scene, null, 2)}\n`);
  // narrate writes its own narrate.log there; this catches what it prints, e.g. a crash.
  const log = openSync(join(dir, "cli-output.log"), "w");
  let code: number | null;
  try {
    code = await spawnAndWait(
      process.execPath,
      [request.narrate, "render", "--scene", sceneFile, "--out", dir],
      dir,
      log,
      request.timeoutMs ?? RENDER_TIMEOUT_MS,
      request.signal,
    );
  } catch (err) {
    // The code only: the message names local paths, and this reaches the PR.
    return { problem: `narrate did not run (${(err as NodeJS.ErrnoException).code ?? "spawn failed"})` };
  } finally {
    closeSync(log);
  }
  if (code === null) return { problem: request.signal?.aborted ? "narration was cancelled" : "narrate took too long and was stopped" };
  if (code !== 0) return { problem: `narrate failed (exit ${code}); see narrate/narrate.log and narrate/cli-output.log` };
  // mp4 by default; the user's narrate settings may ask for webm.
  const made = ["mp4", "webm"].map((ext) => ({ ext, file: join(dir, `walkthrough.${ext}`) })).find((v) => existsSync(v.file));
  if (!made) return { problem: "narrate finished without writing a video; see narrate/narrate.log and narrate/cli-output.log" };
  const video = join(request.outDir, `walkthrough-narrated.${made.ext}`);
  renameSync(made.file, video);
  return { video };
}

/** What narrate reads from the environment besides what the app gets: browsers, settings folder, voice keys. */
export const NARRATE_ENV = ["PLAYWRIGHT_BROWSERS_PATH", "NARRATE_HOME", "NARRATE_GEMINI_API_KEY", "NARRATE_ELEVENLABS_API_KEY"];

/**
 * The narrate CLI's environment: what the app gets (never the factory's tokens) plus NARRATE_ENV.
 * A key under any other name has to be in narrate's settings file.
 */
export function narrateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const wanted = new Set([...APP_ENV_ALLOWLIST, ...NARRATE_ENV].map((n) => n.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([key]) => wanted.has(key.toUpperCase())));
}

/** Exit code, or null when it was stopped for the timeout or the signal. Its whole tree is killed then. */
function spawnAndWait(cmd: string, args: string[], cwd: string, log: number, timeoutMs: number, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(null);
    // Its own process group off Windows, so a kill takes Chromium and ffmpeg down with it.
    const child = spawn(cmd, args, { cwd, env: narrateEnv(process.env), stdio: ["ignore", log, log], windowsHide: true, detached: process.platform !== "win32" });
    // Also killed if the factory itself ends mid-render (Ctrl+C, SIGTERM).
    if (child.pid !== undefined) track(child.pid);
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (child.pid === undefined) return;
      if (process.platform === "win32") killTree(child.pid);
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop);
    const done = () => {
      if (child.pid !== undefined) untrack(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("exit", (code) => {
      done();
      resolve(stopped ? null : code);
    });
  });
}
