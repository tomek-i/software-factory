import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { capturePlanSchema, factoryConfigSchema } from "@factory/shared";
import { git, GIT_TEST_TIMEOUT, repoWithRemote, tempDir } from "../../test/helpers.js";
import { createWorktree } from "../git/worktrees.js";
import { isAlive } from "../util/process.js";
import { launchBrowser } from "./browser.js";
import { playwrightCapture } from "./capture.js";

// Closing Chromium in afterAll can take longer than the default hook timeout on a busy machine.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT, hookTimeout: GIT_TEST_TIMEOUT });

// Only where Playwright and its Chromium are installed; the driver tests cover the rest with a fake.
const launched = await launchBrowser();
const available = "browser" in launched;
afterAll(async () => {
  if ("browser" in launched) await launched.browser.close();
});

/**
 * A tiny app. On main, / links to a stylesheet that is missing (an error that was already there).
 * The branch adds a console error on / and a new /invoices page. Every server appends its pid to
 * $CAPTURE_TEST_PIDS, so the test can check none is left running.
 */
const appJs = (home: string, invoices: string | null) => `const fs = require("fs");
fs.appendFileSync(process.env.CAPTURE_TEST_PIDS, process.pid + "\\n");
const pages = { "/": ${JSON.stringify(home)}, "/invoices": ${JSON.stringify(invoices)} };
require("http").createServer((req, res) => {
  const page = pages[req.url];
  if (!page) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("content-type", "text/html");
  res.end(page);
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
const HOME_V1 = `<html><head><link rel="stylesheet" href="/old.css"></head><body><h1>Home</h1></body></html>`;

describe.skipIf(!available)("playwrightCapture (real browser)", () => {
  it("shoots after and before, records the walkthrough, reports new errors and leaves no server running", async () => {
    // A site the walkthrough must never reach: its link is on the page, the guard blocks it.
    const hits: string[] = [];
    const outside = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end("outside");
    });
    await new Promise<void>((r) => outside.listen(0, "127.0.0.1", () => r()));
    const outsideUrl = `http://127.0.0.1:${(outside.address() as { port: number }).port}/`;

    const { root } = repoWithRemote({ "README.md": "# app\n", "app.js": appJs(HOME_V1, null), ".gitignore": ".worktrees/\n" });
    const worktree = createWorktree({ root, runId: "r1", branch: "factory/1-invoices", defaultBranch: "main" });
    const homeV2 = `<html><head><link rel="stylesheet" href="/old.css"></head><body><h1>Home</h1>
<a href="/invoices">Invoices</a> <a id="away" href="${outsideUrl}">away</a>
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
        { action: "goto", path: "/" },
        { action: "click", selector: "#away" },
        { action: "wait", ms: 100 },
      ],
    });
    const app = { ...factoryConfigSchema.parse({ version: 1 }).app, start: `"${process.execPath}" app.js`, url: "http://127.0.0.1:{port}/", ready_timeout_sec: 60 };

    try {
      const result = await playwrightCapture({ id: "p", name: "demo", repo_path: root, github_repo: "o/r", created_at: "" }).capture({
        runId: "r1",
        root,
        worktreePath: worktree.path,
        defaultBranch: "main",
        app,
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
      expect(walk.video).toBe(join(outDir, "walkthrough.webm"));
      expect(readFileSync(walk.video!).length).toBeGreaterThan(0);
      expect(walk.screenshots).toEqual([join(outDir, "step-search.png")]);
      // The link off the app ends the walkthrough, and the browser never reached the other site.
      expect(walk.problem).toBe("step 6 (click #away) tried to leave the app; the navigation was blocked");
      expect(walk.ran).toBe(6);
      expect(hits).toEqual([]);

      // Media stays out of the branch: nothing new in the worktree, and the before worktree is gone.
      expect(git(worktree.path, "status", "--porcelain")).toBe("");
      expect(existsSync(join(root, ".worktrees", "r1-before"))).toBe(false);
      expect(git(root, "worktree", "list")).not.toContain("r1-before");
    } finally {
      outside.close();
    }
    const started = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
    expect(started).toHaveLength(2); // after and before
    for (const pid of started) expect(isAlive(pid), `server ${pid} still running`).toBe(false);
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
