import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureConfig, CODE_PASS, fakeCapture, infos, steps, UI_TRIAGE } from "../../test/capture-setup.js";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT } from "../../test/helpers.js";
import { MEDIA_MARKER } from "../github/media.js";
import { runDirOf } from "./driver.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("PipelineDriver > capture", () => {
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

  it("plans with the capture agent, captures, uploads the media and puts the table in the PR, without review notes", async () => {
    const capture = fakeCapture();
    const { driver, store, root, edits, reviews, fake, seen } = setup(steps(), { config: captureConfig(), capture: capture.port });
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
    // The minor finding is a review on the PR; capture does not put it back in the description.
    expect(body).not.toContain("Review notes");
    expect(reviews).toHaveLength(1);
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

  // One test per case: each drives a whole run, and three in one test did not fit one test's timeout on a busy machine.
  it.each([
    {
      when: "the app does not start",
      options: { result: { status: "failed", problem: "the app did not start (after): exited (code 1)", pages: [] } },
      pr: "Screenshots could not be taken: `the app did not start (after): exited (code 1)`.",
    },
    { when: "the capture throws", options: { throws: "browser crashed" }, pr: "Screenshots could not be taken: `capture failed: browser crashed`." },
    {
      when: "the upload fails",
      options: { uploadError: "gh release create failed: HTTP 403" },
      pr: "Screenshots were taken but could not be uploaded: `gh release create failed: HTTP 403`.",
    },
  ] satisfies { when: string; options: Parameters<typeof fakeCapture>[0]; pr: string }[])("goes on to the PR when $when, and says so", async ({ options, pr }) => {
    const capture = fakeCapture(options);
    const { driver, root, edits } = setup(steps(), { config: captureConfig(), capture: capture.port });
    const run = driver.startRun(12);
    expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at merge gate: gate is set to human" });
    expect(edits.at(-1)!.body).toContain(`## Screenshots\n${pr} Details: \`factory show ${run.id} capture\`.`);
    const report = readFileSync(join(runDirOf(root, run.id), "round-1", "capture-report.md"), "utf8");
    expect(report).toMatch(/could not be (taken|uploaded)/);
    // Nothing reached GitHub, so there is no release to delete when the run ends unmerged.
    expect(existsSync(join(runDirOf(root, run.id), MEDIA_MARKER))).toBe(false);
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
});
