import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, review, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT, type FakeStep } from "../../test/helpers.js";
import type { CapturePort, CaptureRequest, CaptureResult } from "../capture/capture.js";
import { MEDIA_MARKER } from "../github/media.js";
import { runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver > capture", () => {
  /** One review lens, the merge gate waits for a human, and an app to start unless `app` says otherwise. */
  const captureConfig = (app = 'app:\n  start: "node app.js"\n') =>
    `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  merge: human\nreviews:\n  always: [code]\n  ui: []\n${app}`;
  const UI_TRIAGE = TRIAGE().replace("SURFACES: api", "SURFACES: ui, api");
  // A minor finding, so the PR has review notes the screenshots must not replace.
  const CODE_PASS: FakeStep = { role: "reviewer-code", output: review("PASS", "minor") };
  const PLAN = [
    "CAPTURE: PLAN",
    "",
    "## Summary",
    "- the feature page",
    "",
    "## Plan",
    "```json",
    JSON.stringify({
      pages: [
        { name: "home", path: "/", screen: "existing" },
        { name: "feature", path: "/feature", screen: "new" },
      ],
      walkthrough: [{ action: "goto", path: "/feature" }],
    }),
    "```",
    "",
  ].join("\n");
  const steps = (capture: FakeStep | FakeStep[] = { role: "capture", output: PLAN }): FakeStep[] => [
    { output: UI_TRIAGE },
    buildStep("fixed"),
    CODE_PASS,
    ...[capture].flat(),
  ];

  /**
   * A capture port without a browser: writes stand-in media into the run folder (as the real one
   * does), optionally leaves a file in the worktree, and returns `result` or a captured result.
   */
  function fakeCapture(options: { result?: Partial<CaptureResult>; throws?: string; uploadError?: string; litter?: boolean; attached?: boolean } = {}) {
    const requests: CaptureRequest[] = [];
    const uploads: string[][] = [];
    const prNumbers: (number | null)[] = [];
    const discarded: string[] = [];
    const port: CapturePort = {
      capture: async (request) => {
        requests.push(request);
        if (options.throws) throw new Error(options.throws);
        if (options.litter) writeFileSync(join(request.worktreePath, "server.pid"), "123\n");
        const file = (name: string) => {
          const path = join(request.outDir, name);
          writeFileSync(path, "media");
          return path;
        };
        return {
          status: "captured",
          pages: [
            {
              name: "home",
              path: "/",
              screen: "existing",
              after: [{ width: 1440, file: file("after-home-1440.png"), signals: ["console error: boom", "HTTP 404: GET /old.css"] }],
              before: [{ width: 1440, file: file("before-home-1440.png"), signals: ["HTTP 404: GET /old.css"] }],
            },
            { name: "feature", path: "/feature", screen: "new", after: [{ width: 1440, file: file("after-feature-1440.png"), signals: [] }] },
          ],
          walkthrough: { video: file("walkthrough.webm"), screenshots: [], ran: 1, signals: [] },
          notes: ["no before shot of feature (/feature): it is a new screen"],
          ...options.result,
        };
      },
      // Unless `attached`, attaching fails and the media goes to the draft release, as without a signed-in browser.
      publish: async (runId, prNumber, files) => {
        uploads.push(files);
        prNumbers.push(prNumber);
        if (options.uploadError) throw new Error(options.uploadError);
        if (options.attached) return { urls: Object.fromEntries(files.map((f) => [basename(f), `https://github.com/user-attachments/assets/${basename(f).replace(/\W/g, "-")}`])) };
        const urls = Object.fromEntries(files.map((f) => [basename(f), `https://github.com/o/r/releases/download/factory-media-${runId}/${basename(f)}`]));
        return { urls, release: `factory-media-${runId}`, fallback: "the factory's browser is not signed in to GitHub: run `factory login github`" };
      },
      discard: (runId) => {
        discarded.push(runId);
      },
    };
    return { port, requests, uploads, prNumbers, discarded };
  }

  const infos = (seen: { type: string; message?: string }[]) => seen.flatMap((e) => (e.type === "info" ? [e.message!] : []));

  it("uploads and links the narrated walkthrough instead of the silent one", async () => {
    const narrated = { video: "/x/walkthrough.webm", narrated: "/x/walkthrough-narrated.mp4", screenshots: [], ran: 2, signals: [] };
    const capture = fakeCapture({ result: { walkthrough: narrated } });
    const { driver, edits } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    const uploaded = capture.uploads[0]!.map((f) => basename(f));
    expect(uploaded).toContain("walkthrough-narrated.mp4");
    expect(uploaded).not.toContain("walkthrough.webm");
    const url = `https://github.com/o/r/releases/download/factory-media-${run.id}/walkthrough-narrated.mp4`;
    expect(edits.at(-1)!.body).toContain(`**Walkthrough video (narrated):** [walkthrough-narrated.mp4](${url})`);
  });

  it("attaches the media to the run's PR: everyone can see it, the video plays inline, and there is no release to delete", async () => {
    const capture = fakeCapture({ attached: true });
    const { driver, store, root, edits } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    expect(capture.prNumbers).toEqual([store.getRun(run.id)!.pr_number]);
    const body = edits.at(-1)!.body;
    expect(body).toContain('<img src="https://github.com/user-attachments/assets/after-feature-1440-png"');
    expect(body).toContain("**Walkthrough video:**\n\nhttps://github.com/user-attachments/assets/walkthrough-webm");
    expect(body).not.toContain("only maintainers");
    const dir = runDirOf(root, run.id);
    expect(readFileSync(join(dir, "round-1", "capture-report.md"), "utf8")).toContain("- media uploaded (4 files) as PR attachments");
    expect(existsSync(join(dir, MEDIA_MARKER))).toBe(false);
  });

  it("skips capture without an agent when triage did not list ui, or no app.start is configured", async () => {
    for (const [triage, config, why] of [
      [TRIAGE(), captureConfig(), "triage did not list ui in SURFACES"],
      [UI_TRIAGE, captureConfig(""), "app.start is not configured"],
    ] as const) {
      const capture = fakeCapture();
      const { driver, store, seen, fake } = setup([{ output: triage }, buildStep("fixed"), CODE_PASS], { config, capture: capture.port });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
      expect(infos(seen)).toContain(`capture skipped: ${why}`);
      expect(store.listEvents(run.id).find((e) => e.from_state === "capture")).toMatchObject({ to_state: "pr", reason: `capture skipped: ${why}` });
      expect(fake.calls().map((c) => c.role)).not.toContain("capture");
      expect(capture.requests).toEqual([]);
    }
  });

  it("plans with the capture agent, captures, uploads the media and puts the table in the PR, keeping the review notes", async () => {
    const capture = fakeCapture();
    const { driver, store, root, edits, fake, seen } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    const dir = runDirOf(root, run.id);
    const parked = store.getRun(run.id)!;
    const worktree = parked.worktree_path!;

    // The agent: no shell, only capture.md to write, told where the diff is.
    const agent = fake.calls().find((c) => c.role === "capture")!;
    expect(agent.cwd).toBe(worktree);
    expect(agent.stdin).toContain(join(dir, "round-1", "change.diff"));
    expect(agent.stdin).toContain(`Output file: \`${join(dir, "round-1", "capture.md")}\``);
    const settings = JSON.parse(readFileSync(join(dir, "agent", "capture.settings.json"), "utf8")) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain("Bash");

    // The engine: the plan, the app config, the run's ports, a folder in the run folder.
    const [request] = capture.requests;
    expect(request).toMatchObject({ runId: run.id, worktreePath: worktree, defaultBranch: "main", outDir: join(dir, "round-1", "capture") });
    expect(request!.app).toMatchObject({ start: "node app.js", url: "http://localhost:{port}", port_env: "PORT" });
    expect(request!.plan.pages.map((p) => `${p.name}:${p.screen}`)).toEqual(["home:existing", "feature:new"]);
    expect(request!.ports).toEqual(Array.from({ length: 10 }, (_, i) => parked.port_base! + i));
    expect(request!.signal).toBeInstanceOf(AbortSignal);
    expect(capture.uploads[0]!.map((f) => basename(f))).toEqual(["after-home-1440.png", "before-home-1440.png", "after-feature-1440.png", "walkthrough.webm"]);

    const report = readFileSync(join(dir, "round-1", "capture-report.md"), "utf8");
    expect(report).toContain("- 1 new browser error(s), see New errors");
    expect(report).toContain("### home at 1440px\n- console error: boom");
    expect(report).toContain("- no before shot of feature (/feature): it is a new screen");

    const body = edits.at(-1)!.body;
    const url = (f: string) => `https://github.com/o/r/releases/download/factory-media-${run.id}/${f}`;
    expect(body).toContain("## Screenshots\n\n| Page | Before | After |");
    expect(body).toContain(`<img src="${url("before-home-1440.png")}"`);
    expect(body).toContain(`| **feature** \`/feature\` 1440px | _new screen_ | <img src="${url("after-feature-1440.png")}"`);
    expect(body).toContain(`**Walkthrough video:** [walkthrough.webm](${url("walkthrough.webm")})`);
    expect(body).toContain("- home at 1440px: `console error: boom`");
    expect(body).toContain("- only maintainers signed in to GitHub can see this media (a draft release): `the factory's browser is not signed in to GitHub: run 'factory login github'`");
    expect(readFileSync(join(dir, "round-1", "capture-report.md"), "utf8")).toContain("- media uploaded (4 files) to the draft release, visible to maintainers only: the factory's browser is not signed in to GitHub");
    expect(body).toContain("## Review notes");
    expect(body).toContain("- minor: it says fixed (feature.txt:1)");
    expect(body.indexOf("## Screenshots")).toBeLessThan(body.indexOf("## Review notes"));
    expect(infos(seen).some((m) => m.startsWith("capture: captured 2 page(s)"))).toBe(true);
    // Remembers the release, so rejecting or cancelling the run can delete it.
    expect(readFileSync(join(dir, MEDIA_MARKER), "utf8")).toBe(`factory-media-${run.id}\n`);

    // Nothing media-related is committed: the media is in the (ignored) run folder, not the branch.
    expect(existsSync(join(dir, "round-1", "capture", "walkthrough.webm"))).toBe(true);
    expect(git(root, "check-ignore", join(dir, "round-1", "capture", "walkthrough.webm"))).not.toBe("");
    const committed = git(worktree, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(committed.filter((f) => /\.(png|jpe?g|gif|webm|mp4)$/i.test(f))).toEqual([]);
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/12-add-the-feature").split(/\s+/)[0]).toBe(git(worktree, "rev-parse", "HEAD"));
  });

  it("goes on to the PR when the app does not start, the capture throws or the upload fails, and says so", async () => {
    const cases = [
      { capture: fakeCapture({ result: { status: "failed", problem: "the app did not start (after): exited (code 1)", pages: [] } }), pr: "Screenshots could not be taken: `the app did not start (after): exited (code 1)`." },
      { capture: fakeCapture({ throws: "browser crashed" }), pr: "Screenshots could not be taken: `capture failed: browser crashed`." },
      { capture: fakeCapture({ uploadError: "gh release create failed: HTTP 403" }), pr: "Screenshots were taken but could not be uploaded: `gh release create failed: HTTP 403`." },
    ];
    for (const { capture, pr } of cases) {
      const { driver, root, edits } = setup(steps(), { config: captureConfig(), capture: capture.port });
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
      expect(edits.at(-1)!.body).toContain(`## Screenshots\n${pr} Details: \`factory show ${run.id} capture\`.`);
      const report = readFileSync(join(runDirOf(root, run.id), "round-1", "capture-report.md"), "utf8");
      expect(report).toMatch(/could not be (taken|uploaded)/);
      // Nothing reached GitHub, so there is no release to delete when the run ends unmerged.
      expect(existsSync(join(runDirOf(root, run.id), MEDIA_MARKER))).toBe(false);
    }
  });

  it("keeps the app's log out of the PR: only the first line goes there, the rest stays in the report", async () => {
    const problem = "the app did not start (after): exited (code 1)\n--- log tail ---\nError: DATABASE_URL=postgres://admin:hunter2@db/app\n    at C:\\src\\server.js:3";
    const capture = fakeCapture({ result: { status: "failed", problem, pages: [] } });
    const { driver, store, root, edits } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });

    const body = edits.at(-1)!.body;
    expect(body).toContain("Screenshots could not be taken: `the app did not start (after): exited (code 1)`.");
    expect(body).not.toContain("hunter2");
    expect(body).not.toContain("log tail");
    expect(store.listEvents(run.id).find((e) => e.from_state === "capture")!.reason).not.toContain("hunter2");
    expect(readFileSync(join(runDirOf(root, run.id), "round-1", "capture-report.md"), "utf8")).toContain("postgres://admin:hunter2@db/app");
  });

  it("goes on without screenshots when the capture agent skips, or its plan is invalid twice", async () => {
    const skip: FakeStep = { role: "capture", output: "CAPTURE: SKIP\n\n## Summary\n- only a tooltip text changed\n" };
    const external = PLAN.replace('"path":"/feature"', '"path":"https://evil.example/"');
    const invalid: FakeStep = { role: "capture", output: external };
    for (const [capture, pr] of [
      [skip, "No screenshots: `the capture agent found nothing to show (only a tooltip text changed)`"],
      [[invalid, invalid], "Screenshots could not be taken: `capture agent output was rejected twice: plan.pages.1.path: must be a path on the app's own origin"],
    ] as const) {
      const port = fakeCapture();
      const { driver, edits } = setup(steps(capture as FakeStep | FakeStep[]), { config: captureConfig(), capture: port.port });
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
      expect(edits.at(-1)!.body).toContain(`## Screenshots\n${pr}`);
      expect(port.requests).toEqual([]);
    }
  });

  it("undoes what the app left in the worktree, so the branch stays clean", async () => {
    const capture = fakeCapture({ litter: true });
    const { driver, store, root } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    const worktree = store.getRun(run.id)!.worktree_path!;
    expect(existsSync(join(worktree, "server.pid"))).toBe(false);
    expect(git(worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(runDirOf(root, run.id), "round-1", "capture-report.md"), "utf8")).toContain("the app left changes in the worktree, which were undone: server.pid");
  });

  it("does not start the app on a worktree with uncommitted changes, and never wipes them", async () => {
    // Someone's edit in the worktree, made before the app would start (here: while the capture agent ran).
    const capture = fakeCapture();
    const { driver, store, root, edits } = setup(steps({ role: "capture", output: PLAN, files: { "human.txt": "mine\n" } }), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);
    await driver.drive(run.id);

    const worktree = store.getRun(run.id)!.worktree_path!;
    expect(capture.requests).toEqual([]);
    expect(readFileSync(join(worktree, "human.txt"), "utf8")).toBe("mine\n");
    const why = "the worktree has uncommitted changes (human.txt), so the app was not started";
    expect(readFileSync(join(runDirOf(root, run.id), "round-1", "capture-report.md"), "utf8")).toContain(why);
    expect(edits.at(-1)!.body).toContain(`## Screenshots\nNo screenshots: \`${why}\``);
  });

  it("stops promptly when the run is cancelled while the app runs, without touching the PR", async () => {
    let published = false;
    const { driver, store, edits } = setup(steps(), {
      config: captureConfig(),
      capture: {
        capture: async (request) => {
          new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(request.runId, "changed my mind");
          // The real engine stops the app and the browser when the signal fires.
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("the capture was not told to stop")), 20_000);
            request.signal!.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          return { status: "failed", problem: "cancelled", pages: [], notes: [] };
        },
        publish: async () => {
          published = true;
          return { urls: {} };
        },
        discard: () => undefined,
      },
    });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "cancelled" });
    expect(published).toBe(false);
    expect(edits.some((e) => e.body.includes("## Screenshots"))).toBe(false);
  });

  it("stops when the run is cancelled while the media uploads, and deletes a release made meanwhile", async () => {
    const capture = fakeCapture();
    const { driver, store, root, edits } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const upload = capture.port.publish;
    let signal: AbortSignal | undefined;
    // `factory cancel` lands while the upload runs; the upload then falls back to a release anyway.
    capture.port.publish = async (runId, prNumber, files, s) => {
      signal = s;
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(runId, "changed my mind");
      return upload(runId, prNumber, files, s);
    };
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "cancelled" });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(edits.some((e) => e.body.includes("## Screenshots"))).toBe(false);
    expect(capture.discarded).toEqual([run.id]);
    expect(existsSync(join(runDirOf(root, run.id), MEDIA_MARKER))).toBe(false);
  });

  it("stops at capture when the usage limit is hit, and captures on the next run", async () => {
    const capture = fakeCapture();
    const { driver, store } = setup(steps([{ role: "capture", stream: "rate_limited" }, { role: "capture", output: PLAN }]), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "rate_limited" });
    expect(store.getRun(run.id)!.state).toBe("capture");
    expect(capture.requests).toEqual([]);

    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    expect(capture.requests).toHaveLength(1);
  });
});
