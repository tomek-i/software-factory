import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { capturePlanSchema, factoryConfigSchema } from "@factory/shared";
import { git, GIT_TEST_TIMEOUT, repoWithRemote, tempDir } from "../../test/helpers.js";
import { createWorktree } from "../git/worktrees.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
import { isAlive } from "../util/process.js";
import { chromiumInstalled } from "./browser.js";
import { playwrightCapture } from "./capture.js";

// Each test starts real apps (up to two at a time, each allowed 60s to answer) and a real Chromium:
// about 15s alone, but over 120s while the rest of the suite loads the machine. Slow, not failing.
vi.setConfig({ testTimeout: 2.5 * GIT_TEST_TIMEOUT });

// Only where Playwright and its Chromium are installed; the driver tests cover the rest with a fake.
// FACTORY_REQUIRE_BROWSER=1 turns a missing browser into a failure instead of a silent skip.
const available = await chromiumInstalled();
const required = process.env.FACTORY_REQUIRE_BROWSER === "1";

describe("the real-browser tests", () => {
  it.runIf(required)("have Playwright's Chromium when FACTORY_REQUIRE_BROWSER=1", () => {
    expect(available, "Chromium is missing: run `pnpm exec playwright install chromium`").toBe(true);
  });
});

/**
 * A tiny app. On main, / links to a stylesheet that is missing (an error that was already there).
 * The branch adds a console error on / and a new /invoices page. Every server appends its pid to
 * $CAPTURE_TEST_PIDS, so the test can check none is left running. `redirects` answer with a 302.
 */
const appJs = (home: string, invoices: string | null, redirects: Record<string, string> = {}) => `const fs = require("fs");
fs.appendFileSync(process.env.CAPTURE_TEST_PIDS, process.pid + "\\n");
const pages = { "/": ${JSON.stringify(home)}, "/invoices": ${JSON.stringify(invoices)} };
const redirects = ${JSON.stringify(redirects)};
require("http").createServer((req, res) => {
  if (redirects[req.url]) { res.statusCode = 302; res.setHeader("location", redirects[req.url]); return res.end(); }
  const page = pages[req.url];
  if (!page) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("content-type", "text/html");
  res.end(page);
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
const HOME_V1 = `<html><head><link rel="stylesheet" href="/old.css"></head><body><h1>Home</h1></body></html>`;
const testApp = {
  ...factoryConfigSchema.parse({ version: 1 }).app,
  start: `"${process.execPath}" app.js`,
  url: "http://127.0.0.1:{port}/",
  ready_timeout_sec: 60,
  // The app gets nothing else from the environment, so the pid file is asked for by name.
  env: ["CAPTURE_TEST_PIDS"],
};

describe.skipIf(!available)("playwrightCapture (real browser)", () => {
  it("shoots after and before, records the walkthrough, reports new errors and leaves no server running", async () => {
    const { root } = repoWithRemote({ "README.md": "# app\n", "app.js": appJs(HOME_V1, null), ".gitignore": ".worktrees/\n" });
    const worktree = createWorktree({ root, runId: "r1", branch: "factory/1-invoices", defaultBranch: "main" });
    const homeV2 = `<html><head><link rel="stylesheet" href="/old.css"></head><body><h1>Home</h1>
<a href="/invoices">Invoices</a>
<script>console.error("boom")</script></body></html>`;
    const invoices = `<html><body><h1>Invoices</h1><input id="q"><script>window.missing.call()</script></body></html>`;
    writeFileSync(join(worktree.path, "app.js"), appJs(homeV2, invoices));
    git(worktree.path, "commit", "-qam", "feat: invoices");

    const pids = join(tempDir(), "pids.txt");
    writeFileSync(pids, "");
    process.env.CAPTURE_TEST_PIDS = pids;
    const outDir = join(root, ".factory", "runs", "r1", "round-1", "capture");
    const plan = capturePlanSchema.parse({
      pages: [
        { name: "home", path: "/", screen: "existing" },
        { name: "invoices", path: "/invoices", screen: "new" },
      ],
      walkthrough: [
        { action: "goto", path: "/" },
        { action: "click", text: "Invoices" },
        { action: "fill", selector: "#q", value: "acme" },
        { action: "screenshot", name: "search" },
      ],
    });
    const result = await playwrightCapture({ id: "p", name: "demo", repo_path: root, github_repo: "o/r", created_at: "" }).capture({
      runId: "r1",
      root,
      worktreePath: worktree.path,
      defaultBranch: "main",
      app: testApp,
      plan,
      outDir,
      ports: [],
    });

    expect(result.status).toBe("captured");
    const [home, inv] = result.pages;
    expect(home!.after.map((s) => s.width)).toEqual([1440, 390]);
    for (const s of [...home!.after, ...home!.before!, ...inv!.after]) expect(existsSync(s.file!), s.file).toBe(true);
    // The missing stylesheet was there before, the console error is new; the new page has no before.
    expect(home!.before![0]!.signals).toEqual(["HTTP 404: GET /old.css"]);
    expect(home!.after[0]!.signals).toEqual(expect.arrayContaining(["HTTP 404: GET /old.css", "console error: boom"]));
    expect(inv!.before).toBeUndefined();
    expect(inv!.after[0]!.signals.some((s) => s.startsWith("page error:"))).toBe(true);
    expect(result.notes).toEqual(["no before shot of invoices (/invoices): it is a new screen"]);

    const walk = result.walkthrough!;
    expect(walk).toMatchObject({ ran: 4, screenshots: [join(outDir, "step-search.png")], video: join(outDir, "walkthrough.webm") });
    expect(walk.problem).toBeUndefined();
    expect(readFileSync(walk.video!).length).toBeGreaterThan(0);

    // Media stays out of the branch: nothing new in the worktree, and the before worktree is gone.
    expect(git(worktree.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(root, ".worktrees", "r1-before"))).toBe(false);
    expect(git(root, "worktree", "list")).not.toContain("r1-before");
    const started = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
    expect(started).toHaveLength(2); // after and before
    for (const pid of started) expect(isAlive(pid), `server ${pid} still running`).toBe(false);
  });

  it("never shoots or records a page outside the app, whether a redirect or a link leads there", async () => {
    // The site the app tries to send the browser to: it must never be asked for anything.
    const hits: string[] = [];
    const outside = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("<h1>outside</h1>");
    });
    await new Promise<void>((r) => outside.listen(0, "127.0.0.1", () => r()));
    const outsideUrl = `http://127.0.0.1:${(outside.address() as { port: number }).port}/`;
    const home = `<html><body><h1>Home</h1><a id="away" href="${outsideUrl}link">away</a></body></html>`;
    const { root } = repoWithRemote({ "README.md": "# app\n", "app.js": appJs(home, null, { "/go": `${outsideUrl}redirect` }) });
    const pids = join(tempDir(), "pids.txt");
    writeFileSync(pids, "");
    process.env.CAPTURE_TEST_PIDS = pids;
    const outDir = join(tempDir(), "capture");
    const capture = (walkthrough: unknown[]) =>
      playwrightCapture({ id: "p", name: "demo", repo_path: root, github_repo: "o/r", created_at: "" }).capture({
        runId: "r3",
        root,
        worktreePath: root,
        defaultBranch: "main",
        app: testApp,
        plan: capturePlanSchema.parse({ pages: [{ name: "go", path: "/go", screen: "new" }], walkthrough }),
        outDir,
        ports: [],
      });

    try {
      const redirected = await capture([{ action: "goto", path: "/go" }]);
      expect(redirected.status).toBe("captured");
      for (const shot of redirected.pages[0]!.after) {
        expect(shot.file).toBeUndefined();
        expect(shot.error).toBe("the page led away from the app, so it was not shot");
      }
      expect(redirected.walkthrough).toMatchObject({ ran: 0, problem: "step 1 (goto /go) left the app; the video was discarded, as it may show a page outside the app" });
      expect(redirected.walkthrough!.video).toBeUndefined();
      expect(existsSync(join(outDir, "walkthrough.webm"))).toBe(false);

      const clicked = await capture([{ action: "goto", path: "/" }, { action: "click", selector: "#away" }, { action: "screenshot", name: "away" }]);
      expect(clicked.walkthrough).toMatchObject({ ran: 2, screenshots: [], problem: "step 2 (click #away) left the app; the video was discarded, as it may show a page outside the app" });
      expect(clicked.walkthrough!.video).toBeUndefined();
      expect(hits).toEqual([]);
    } finally {
      outside.close();
    }
    for (const pid of readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)) expect(isAlive(pid), `server ${pid} still running`).toBe(false);
  });

  it("narrates a walkthrough that went through, while the app still runs, and only then", async () => {
    const home = `<html><body><h1>Home</h1><button id="go">Go</button></body></html>`;
    const { root } = repoWithRemote({ "README.md": "# app\n", "app.js": appJs(home, null) });
    const pids = join(tempDir(), "pids.txt");
    writeFileSync(pids, "");
    process.env.CAPTURE_TEST_PIDS = pids;
    // A stand-in for narrate.mjs: it fetches the scene's site, so the video holds the app's page.
    const narrate = join(tempDir("fake-narrate-"), "narrate.mjs");
    writeFileSync(
      narrate,
      `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const scene = JSON.parse(readFileSync(args[args.indexOf("--scene") + 1], "utf8"));
const page = await (await fetch(scene.site)).text();
const video = join(args[args.indexOf("--out") + 1], "walkthrough.mp4");
writeFileSync(video, JSON.stringify({ beats: scene.beats, page }));
console.log(JSON.stringify({ ok: true, video }));
`,
    );
    const outDir = join(tempDir(), "capture");
    // ffmpeg is faked; everything else (git) is real.
    const run: CommandRunner = (cmd, args, options) => (cmd === "ffmpeg" ? { code: 0, stdout: "", stderr: "" } : runCommand(cmd, args, options));
    const capture = (walkthrough: unknown[]) =>
      playwrightCapture({ id: "p", name: "demo", repo_path: root, github_repo: "o/r", created_at: "" }, run).capture({
        runId: "r4",
        root,
        worktreePath: root,
        defaultBranch: "main",
        app: { ...testApp, narrate },
        plan: capturePlanSchema.parse({ pages: [{ name: "home", path: "/", screen: "new" }], walkthrough }),
        outDir,
        ports: [],
      });

    const told = await capture([
      { action: "goto", path: "/", say: "The home page has a new button." },
      { action: "click", selector: "#go", say: "Pressing it goes on." },
    ]);
    const walk = told.walkthrough!;
    expect(walk).toMatchObject({ ran: 2, video: join(outDir, "walkthrough.webm"), narrated: join(outDir, "walkthrough-narrated.mp4") });
    expect(walk.narrationProblem).toBeUndefined();
    const video = JSON.parse(readFileSync(walk.narrated!, "utf8")) as { beats: { say: string }[]; page: string };
    expect(video.beats.map((b) => b.say)).toEqual(["The home page has a new button.", "Pressing it goes on."]);
    expect(video.page).toContain("<h1>Home</h1>");

    rmSync(walk.narrated!);
    const stopped = await capture([{ action: "goto", path: "/", say: "Hello." }, { action: "click", selector: "#missing" }]);
    expect(stopped.walkthrough!.narrated).toBeUndefined();
    expect(stopped.walkthrough!.narrationProblem).toBe("not narrated, as the silent walkthrough did not finish");
    expect(existsSync(join(outDir, "walkthrough-narrated.mp4"))).toBe(false);
    for (const pid of readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)) expect(isAlive(pid), `server ${pid} still running`).toBe(false);
  });

  it("reports an app that does not start, without throwing", async () => {
    const { root } = repoWithRemote({ "README.md": "# app\n" });
    const plan = capturePlanSchema.parse({ pages: [{ name: "home", path: "/", screen: "existing" }] });
    const app = { ...factoryConfigSchema.parse({ version: 1 }).app, start: `"${process.execPath}" -e "process.exit(1)"`, ready_timeout_sec: 30 };
    const result = await playwrightCapture({ id: "p", name: "demo", repo_path: root, github_repo: "o/r", created_at: "" }).capture({
      runId: "r2",
      root,
      worktreePath: root,
      defaultBranch: "main",
      app,
      plan,
      outDir: join(tempDir(), "capture"),
      ports: [],
    });
    expect(result).toMatchObject({ status: "failed", pages: [] });
    expect(result.problem).toMatch(/^the app did not start \(after\): .* exited \(code 1\)/);
  });
});
