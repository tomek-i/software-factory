import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { walkthroughStepSchema, type WalkthroughStep } from "@factory/shared";
import { tempDir } from "../../test/helpers.js";
import type { CommandRunner } from "../util/exec.js";
import { isAlive } from "../util/process.js";
import { findNarrate, narrateEnv, narrationScene, renderNarrated, type NarrationScene } from "./narrate.js";
import { chromiumInstalled } from "./browser.js";
import { runCommand } from "../util/exec.js";

/** A plugin cache with narrate at these versions, each with a bin/narrate.mjs. */
function pluginCache(versions: string[], marketplace = "narrate-marketplace"): string {
  const home = tempDir("narrate-home-");
  for (const v of versions) {
    const bin = join(home, ".claude", "plugins", "cache", marketplace, "narrate", v, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "narrate.mjs"), "");
  }
  return home;
}

describe("findNarrate", () => {
  it("takes the newest installed version, comparing versions as numbers", () => {
    const home = pluginCache(["0.9.0", "0.10.0", "0.2.5", "latest"]);
    expect(findNarrate("auto", home)).toBe(join(home, ".claude", "plugins", "cache", "narrate-marketplace", "narrate", "0.10.0", "bin", "narrate.mjs"));
  });

  it("finds nothing without the plugin, or when it is off", () => {
    expect(findNarrate("auto", tempDir("narrate-home-"))).toBeUndefined();
    expect(findNarrate("off", pluginCache(["1.0.0"]))).toBeUndefined();
  });

  it("uses a configured path only when it exists, made absolute", () => {
    const file = join(tempDir("narrate-path-"), "narrate.mjs");
    expect(findNarrate(file)).toBeUndefined();
    writeFileSync(file, "");
    expect(findNarrate(file)).toBe(file);
    // narrate runs from its own folder, so a path relative to the factory's must not stay relative.
    expect(findNarrate(relative(process.cwd(), file))).toBe(file);
  });
});

describe("narrationScene", () => {
  const steps = (raw: unknown[]): WalkthroughStep[] => raw.map((s) => walkthroughStepSchema.parse(s));

  it("is undefined when nothing is said", () => {
    expect(narrationScene(steps([{ action: "goto", path: "/" }]), "http://127.0.0.1:4000/")).toBeUndefined();
  });

  it("starts a beat at each step that says something, and maps only the plan's own actions", () => {
    const scene = narrationScene(
      steps([
        { action: "goto", path: "/settings?tab=a" },
        { action: "wait", ms: 0 },
        { action: "click", text: 'Billing >> "x"', say: "Settings has a billing tab." },
        { action: "fill", selector: "#company", value: "Acme" },
        { action: "screenshot", name: "filled" },
        { action: "click", selector: "button[type=submit]", say: "Saving shows a confirmation." },
        { action: "wait", ms: 500 },
      ]),
      "http://127.0.0.1:4000/app/",
    );
    expect(scene).toEqual<NarrationScene>({
      name: "walkthrough",
      site: "http://127.0.0.1:4000/",
      viewport: { width: 1280, height: 720 },
      beats: [
        {
          id: "beat-1",
          say: "Settings has a billing tab.",
          do: [
            { action: "navigate", url: "http://127.0.0.1:4000/settings?tab=a" },
            { action: "click", selector: 'internal:text="Billing >> \\"x\\""i' },
            { action: "fill", selector: "#company", text: "Acme" },
          ],
        },
        { id: "beat-2", say: "Saving shows a confirmation.", do: [{ action: "click", selector: "button[type=submit]" }, { action: "wait", ms: 500 }] },
      ],
    });
  });
});

describe("narrationScene fill values", () => {
  it("escapes narrate's ${NAME} expansion, so a value is typed as written", () => {
    const scene = narrationScene([walkthroughStepSchema.parse({ action: "fill", selector: "#q", value: "${USERPROFILE} and $${X}", say: "Typing." })], "http://127.0.0.1:1/");
    expect(scene!.beats[0]!.do).toEqual([{ action: "fill", selector: "#q", text: "$${USERPROFILE} and $$${X}" }]);
  });
});

describe("narrateEnv", () => {
  it("keeps what narrate needs and never the factory's tokens", () => {
    const env = narrateEnv({ PATH: "p", NARRATE_HOME: "h", NARRATE_ELEVENLABS_API_KEY: "k", PLAYWRIGHT_BROWSERS_PATH: "b", GH_TOKEN: "t", ANTHROPIC_API_KEY: "a", AWS_SECRET_ACCESS_KEY: "s" });
    expect(env).toEqual({ PATH: "p", NARRATE_HOME: "h", NARRATE_ELEVENLABS_API_KEY: "k", PLAYWRIGHT_BROWSERS_PATH: "b" });
  });
});

describe("the walkthrough step schema", () => {
  it("takes one line of narration and refuses line breaks", () => {
    expect(walkthroughStepSchema.safeParse({ action: "goto", path: "/", say: "Hello there." }).success).toBe(true);
    expect(walkthroughStepSchema.safeParse({ action: "goto", path: "/", say: "one\ntwo" }).success).toBe(false);
    expect(walkthroughStepSchema.safeParse({ action: "goto", path: "/", say: "x".repeat(301) }).success).toBe(false);
  });
});

/**
 * A stand-in for narrate.mjs. What it does comes from mode.txt next to it (its environment is
 * filtered): `ok` writes walkthrough.mp4, `fail` exits 1, `none` writes nothing, `hang` never ends
 * (after writing its pid). It always records its arguments and environment.
 */
function fakeNarrate(mode: "ok" | "fail" | "none" | "hang"): string {
  const dir = tempDir("fake-narrate-");
  writeFileSync(join(dir, "mode.txt"), mode);
  const script = join(dir, "narrate.mjs");
  writeFileSync(
    script,
    `import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
const here = dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, "$1"));
const mode = readFileSync(join(here, "mode.txt"), "utf8");
const args = process.argv.slice(2);
writeFileSync(join(here, "seen.json"), JSON.stringify({ args, cwd: process.cwd(), env: process.env }));
const out = args[args.indexOf("--out") + 1];
if (mode === "ok") writeFileSync(join(out, "walkthrough.mp4"), readFileSync(args[args.indexOf("--scene") + 1]));
if (mode === "fail") { console.error("boom"); process.exit(1); }
if (mode === "hang") { writeFileSync(join(here, "pid.txt"), String(process.pid)); setInterval(() => {}, 1000); }
`,
  );
  return script;
}

const ffmpeg = (present: boolean): CommandRunner => () => ({ code: present ? 0 : 1, stdout: "", stderr: "" });
const scene: NarrationScene = { name: "walkthrough", site: "http://127.0.0.1:1/", viewport: { width: 1280, height: 720 }, beats: [{ id: "beat-1", say: "Hi.", do: [] }] };

describe("renderNarrated", () => {
  it("renders the scene into the capture folder, from its own folder, without the factory's tokens", async () => {
    const narrate = fakeNarrate("ok");
    const outDir = tempDir("narrate-out-");
    process.env.GH_TOKEN_FOR_NARRATE_TEST = "secret";
    try {
      const result = await renderNarrated({ narrate, scene, outDir, run: ffmpeg(true) });
      expect(result).toEqual({ video: join(outDir, "walkthrough-narrated.mp4") });
      expect(JSON.parse(readFileSync(join(outDir, "walkthrough-narrated.mp4"), "utf8"))).toEqual(scene);
      const seen = JSON.parse(readFileSync(join(narrate, "..", "seen.json"), "utf8")) as { args: string[]; cwd: string; env: Record<string, string> };
      expect(seen.args).toEqual(["render", "--scene", join(outDir, "narrate", "walkthrough.scene.json"), "--out", join(outDir, "narrate")]);
      expect(seen.cwd.toLowerCase()).toBe(join(outDir, "narrate").toLowerCase());
      expect(Object.keys(seen.env).some((k) => k.toUpperCase().startsWith("GH_TOKEN"))).toBe(false);
      expect(Object.keys(seen.env).some((k) => k.toUpperCase() === "PATH")).toBe(true);
    } finally {
      delete process.env.GH_TOKEN_FOR_NARRATE_TEST;
    }
  });

  it("says why there is no video", async () => {
    const outDir = tempDir("narrate-out-");
    expect(await renderNarrated({ narrate: fakeNarrate("ok"), scene, outDir, run: ffmpeg(false) })).toEqual({ problem: "ffmpeg is not on PATH; narrate needs it to add the voice" });
    expect(await renderNarrated({ narrate: fakeNarrate("fail"), scene, outDir, run: ffmpeg(true) })).toEqual({ problem: "narrate failed (exit 1); see narrate/narrate.log and narrate/cli-output.log" });
    expect(readFileSync(join(outDir, "narrate", "cli-output.log"), "utf8")).toContain("boom");
    expect(await renderNarrated({ narrate: fakeNarrate("none"), scene, outDir, run: ffmpeg(true) })).toEqual({
      problem: "narrate finished without writing a video; see narrate/narrate.log and narrate/cli-output.log",
    });
  });

  it("stops a render that takes too long, or is cancelled, and leaves nothing running", async () => {
    for (const how of ["timeout", "cancel"] as const) {
      const narrate = fakeNarrate("hang");
      const controller = new AbortController();
      const pending = renderNarrated({ narrate, scene, outDir: tempDir("narrate-out-"), run: ffmpeg(true), timeoutMs: how === "timeout" ? 1500 : 60_000, signal: controller.signal });
      const pidFile = join(narrate, "..", "pid.txt");
      while (!existsSync(pidFile)) await new Promise((r) => setTimeout(r, 50));
      if (how === "cancel") controller.abort();
      expect(await pending).toEqual({ problem: how === "timeout" ? "narrate took too long and was stopped" : "narration was cancelled" });
      const pid = Number(readFileSync(pidFile, "utf8"));
      for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
      expect(isAlive(pid)).toBe(false);
    }
  }, 30_000);
});

// Against the real plugin, where it is installed with ffmpeg and Chromium, with narrate's silent
// "mock" voice (no TTS key, no cost): catches a scene that narrate's own schema no longer accepts.
const realNarrate = findNarrate("auto");
const canRender = realNarrate !== undefined && runCommand("ffmpeg", ["-version"], { cwd: process.cwd() }).code === 0 && (await chromiumInstalled());

describe.skipIf(!canRender)("renderNarrated with the real narrate plugin", () => {
  it("renders the engine's scene, with a fill value that looks like a variable typed as written", async () => {
    const server = createServer((_, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<html><body><h1>Home</h1><input id="q"><button id="go">Go</button></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const home = tempDir("narrate-settings-");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ tts: { provider: "mock" } }));
    const before = process.env.NARRATE_HOME;
    process.env.NARRATE_HOME = home;
    try {
      const steps = [
        { action: "goto", path: "/", say: "The home page." },
        // Unset on purpose: unescaped, narrate would refuse the scene.
        { action: "fill", selector: "#q", value: "${FACTORY_NARRATE_TEST_UNSET}" },
        { action: "click", text: "go", say: "Go." },
      ].map((s) => walkthroughStepSchema.parse(s));
      const outDir = tempDir("narrate-real-");
      const result = await renderNarrated({ narrate: realNarrate!, scene: narrationScene(steps, `http://127.0.0.1:${(server.address() as { port: number }).port}/`)!, outDir });
      expect(result, readFileSync(join(outDir, "narrate", "cli-output.log"), "utf8")).toEqual({ video: join(outDir, "walkthrough-narrated.mp4") });
    } finally {
      if (before === undefined) delete process.env.NARRATE_HOME;
      else process.env.NARRATE_HOME = before;
      server.close();
    }
  }, 300_000);
});
