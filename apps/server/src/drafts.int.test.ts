import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DRAFTS_DIR, findRepoRoot, loadConfig, runCommand, Store, type CommandRunner, type IssueWriterPort, type ProjectContext } from "@factory/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, GIT_TEST_TIMEOUT, repoWithRemote, type FakeStep } from "../../../packages/core/test/helpers.js";
import type { DraftDetail, DraftView } from "./drafts.js";
import { EventHub, type HubEvent } from "./hub.js";
import { projectKey, ProjectSet } from "./projects.js";
import { createServer, type ServerOptions } from "./server.js";

// Each test drives a real git repo and a fake claude process; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

/** The fake GitHub's labels, with a status label the issue writer must never be offered. */
const REPO_LABELS = [
  { name: "ui", description: "Visible changes" },
  { name: "bug", description: "" },
  { name: "factory", description: "Queued in the software factory" },
];
const TOKEN = "a".repeat(64);
const HOST = "127.0.0.1:4180";
const HEADERS = { host: HOST, "x-factory-token": TOKEN };

const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.\n";
const SINGLE = `DECISION: PROCEED\n\n## Summary\n- drafted\n\n=== ISSUE ===\nTITLE: Add CSV export\nUI: NO\nRISK: LOW\n\n${SECTIONS}`;

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/**
 * A registered repo whose default branch sets `gates.issue_writer`, served with the fake claude, a
 * fake GitHub that numbers issues from 20 and a `gh issue view` that answers for them.
 */
function setup(steps: FakeStep[], gate = "human", options: Partial<ServerOptions> = {}) {
  const config = `version: 1\ntrust:\n  authors: [alice]\ngates:\n  issue_writer: ${gate}\n`;
  const { root: dir } = repoWithRemote({ "README.md": "# demo\n", ".gitignore": ".factory/runs/\n.factory/factory.db*\n", ".factory/config.yaml": config });
  const root = findRepoRoot(dir)!;
  const store = new Store(join(root, ".factory", "factory.db"));
  const project = store.upsertProject({ name: "demo", repo_path: root, github_repo: "o/r" });
  const ctx: ProjectContext = { root, store, project, config: loadConfig(root) };

  const created: { number: number; title: string; body: string; labels?: string[] }[] = [];
  const links: [number, number][] = [];
  const github: IssueWriterPort = {
    createIssue: ({ title, body, labels }) => {
      created.push({ number: 20 + created.length, title, body, labels });
      return created.at(-1)!.number;
    },
    listLabels: () => REPO_LABELS,
    addSubIssue: (parent, child) => links.push([parent, child]),
  };
  const run: CommandRunner = (cmd, args, options) => {
    if (cmd !== "gh") return runCommand(cmd, args, options);
    const issue = created.find((c) => c.number === Number(args[2]));
    if (args[1] !== "view" || !issue) return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    const json = { ...issue, state: "OPEN", author: { login: "factory-operator" }, labels: [], url: `https://github.com/o/r/issues/${issue.number}`, updatedAt: "2026-11-01T00:00:00Z" };
    return { code: 0, stdout: JSON.stringify(json), stderr: "" };
  };

  const fake = fakeClaude(steps);
  const hub = new EventHub();
  const events: HubEvent[] = [];
  hub.subscribe((p) => events.push(p.event));
  const projects = new ProjectSet(
    () => [{ path: root, name: "demo", added_at: "t" }],
    () => ctx,
  );
  const app = createServer({ projects, hub, token: TOKEN, port: 4180, run, env: fake.env, issueWriter: () => github, log: () => {}, ...options });
  apps.push(app);
  const key = projectKey(root);
  const base = `/api/projects/${key}/drafts`;

  const get = <T>(url: string) => app.inject({ method: "GET", url, headers: HEADERS }).then((res) => ({ status: res.statusCode, body: res.json() as T }));
  const post = (url: string, payload: object = {}) =>
    app.inject({ method: "POST", url, payload, headers: { ...HEADERS, origin: `http://${HOST}` } }).then((res) => ({ status: res.statusCode, body: res.json() }));
  /** The final event of the draft's issue writer. */
  const done = async (id: string) =>
    vi.waitFor(
      () => {
        const event = events.find((e) => e.type === "draft:done" && e.draftId === id);
        if (!event || event.type !== "draft:done") throw new Error("still writing");
        return event.result;
      },
      { timeout: GIT_TEST_TIMEOUT, interval: 50 },
    );
  const start = async (idea: string, queue?: boolean) => {
    const res = await post(base, { idea, ...(queue === undefined ? {} : { queue }) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.id as string;
  };
  const issues = () => store.listIssues({ project_id: project.id });
  return { root, key, base, app, hub, events, created, links, fake, get, post, start, done, issues, ctx };
}

const editOf = (title: string, subIssues: { title: string; dependsOn?: number[]; labels?: string[] }[] = []) => ({
  issue: { title, ui: false, risk: "LOW", body: SECTIONS },
  subIssues: subIssues.map((s) => ({ ui: true, risk: "MEDIUM", body: SECTIONS, ...s })),
});

describe("drafts from the web", () => {
  it("streams an idea's progress to a waiting draft, then saves an edit, refuses a broken one and publishes it", async () => {
    const { root, key, base, events, created, links, fake, get, post, done, issues } = setup([{ role: "issue_writer", output: SINGLE }]);

    const res = await post(base, { idea: "Export orders as CSV" });
    expect(res.body).toEqual({ id: expect.stringMatching(/^draft-[0-9a-f]{8}$/), ignored: [".factory/drafts/"] });
    const id = res.body.id as string;

    expect(await done(id)).toEqual({ kind: "waiting", reasons: [expect.stringContaining("human")] });
    expect(fake.calls()[0]!.stdin).toContain("Export orders as CSV");
    const progress = events.flatMap((e) => (e.type === "draft" && e.draftId === id ? [e.event.type] : []));
    expect(progress).toContain("agent:start");
    expect(progress).toContain("agent:end");
    expect(events.at(-1)).toEqual({ type: "changed", project: key });
    expect(created).toEqual([]);

    const listed = await get<DraftView[]>("/api/drafts");
    expect(listed.body).toEqual([
      {
        project: key,
        projectName: "demo",
        id,
        idea: "Export orders as CSV",
        createdAt: expect.any(String),
        running: false,
        draft: expect.objectContaining({ decision: "PROCEED", issue: expect.objectContaining({ title: "Add CSV export" }) }),
        problems: [],
        refusal: null,
        created: [],
      },
    ]);
    expect((await get<DraftView[]>(`/api/drafts?project=${key}`)).body).toEqual(listed.body);
    const detail = await get<DraftDetail>(`${base}/${id}`);
    expect(detail.body).toMatchObject({ id, pending: { id, text: SINGLE }, job: { running: false, result: { kind: "waiting" } } });
    expect(detail.body.job!.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(detail.body)).not.toContain(JSON.stringify(root).slice(1, -1));

    // A broken edit is refused with the lines `factory new --approve` would print, and nothing is written.
    const file = join(root, DRAFTS_DIR, id, "draft.md");
    const broken = await post(`${base}/${id}/save`, { ...editOf("Exports"), issue: { ...editOf("Exports").issue, body: SECTIONS.replace("## Acceptance criteria\n- [ ] it works\n", "") } });
    expect(broken).toEqual({ status: 400, body: { error: `Draft ${id} is not valid:\n- issue: section ## Acceptance criteria is missing\nNothing was saved. Fix it and save it again, or discard it.` } });
    const single = await post(`${base}/${id}/save`, editOf("Exports", [{ title: "CSV export" }]));
    expect(single.status).toBe(400);
    expect(single.body.error).toContain("- a parent issue needs at least two sub-issues; write a single issue instead");
    expect((await post(`${base}/${id}/save`, { issue: { title: 5 }, subIssues: [] })).body).toEqual({ error: "issue.title must be text." });
    const badLabels = editOf("Exports");
    expect((await post(`${base}/${id}/save`, { ...badLabels, issue: { ...badLabels.issue, labels: "ui" } })).body).toEqual({ error: "issue.labels must be a list of text." });
    expect(readFileSync(file, "utf8")).toBe(SINGLE);

    const saved = await post(`${base}/${id}/save`, editOf("Exports", [{ title: "CSV export", labels: ["UI"] }, { title: "Excel export", dependsOn: [1] }]));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.draft.subIssues.map((s: { title: string; dependsOn: number[] }) => [s.title, s.dependsOn])).toEqual([
      ["CSV export", []],
      ["Excel export", [1]],
    ]);
    expect(readFileSync(file, "utf8")).toContain("=== SUB-ISSUE ===\nTITLE: Excel export\nUI: YES\nRISK: MEDIUM\nDEPENDS_ON: 1\n");

    const published = await post(`${base}/${id}/publish`, { queue: true });
    expect(published).toEqual({
      status: 200,
      body: {
        issue: { number: 20, title: "Exports", url: "https://github.com/o/r/issues/20" },
        subIssues: [
          { number: 21, title: "CSV export", url: "https://github.com/o/r/issues/21" },
          { number: 22, title: "Excel export", url: "https://github.com/o/r/issues/22" },
        ],
        buildable: [21, 22],
        queued: [21, 22],
      },
    });
    expect(created[2]!.body).toContain("**Depends on:** #21");
    expect(created.map((c) => c.labels)).toEqual([[], ["ui"], []]);
    expect(links).toEqual([
      [20, 21],
      [20, 22],
    ]);
    expect(issues().map((i) => [i.number, i.created_by_factory, i.queued_at !== null])).toEqual([
      [22, true, true],
      [21, true, true],
      [20, true, false],
    ]);
    expect((await get(`${base}/${id}`)).body).toMatchObject({ pending: null, job: { running: false, result: { kind: "published", published: { issue: { number: 20 } } } } });
    expect((await get("/api/drafts")).body).toEqual([]);
    expect((await post(`${base}/${id}/publish`)).status).toBe(404);
  });

  it("creates the draft without a human step when the issue_writer gate lets it through, queuing only when asked", async () => {
    const { start, done, created, issues } = setup([{ output: SINGLE }], "always");

    const id = await start("Export orders as CSV");

    expect(await done(id)).toEqual({
      kind: "published",
      published: { issue: { number: 20, title: "Add CSV export", url: "https://github.com/o/r/issues/20" }, subIssues: [], buildable: [20], queued: [] },
    });
    expect(created.map((c) => c.title)).toEqual(["Add CSV export"]);
    expect(issues()).toMatchObject([{ number: 20, created_by_factory: true, queued_at: null }]);
  });

  it("queues the created issue when the start asked for it and the gate lets it through", async () => {
    const { start, done, issues } = setup([{ output: SINGLE }], "always");
    const id = await start("Export orders as CSV", true);
    expect(await done(id)).toMatchObject({ kind: "published", published: { queued: [20] } });
    expect(issues()[0]!.queued_at).not.toBeNull();
  });

  it("refuses changes while the issue writer runs, stops it, then discards the draft", async () => {
    const { root, base, get, post, start, done } = setup([{ output: SINGLE, sleepMs: 60_000 }]);
    const id = await start("a slow idea");

    expect((await get<DraftView[]>("/api/drafts")).body).toMatchObject([{ id, running: true, draft: null, problems: [] }]);
    for (const action of ["save", "publish", "discard"]) {
      const res = await post(`${base}/${id}/${action}`, editOf("T"));
      expect(res, action).toEqual({ status: 409, body: { error: `The issue writer is still writing ${id}. Wait for it, or stop it first.` } });
    }
    expect(existsSync(join(root, DRAFTS_DIR, id))).toBe(true);

    expect(await post(`${base}/${id}/stop`)).toEqual({ status: 200, body: { id, stopping: true } });
    expect(await done(id)).toMatchObject({ kind: "failed", error: expect.stringMatching(/^The issue writer failed/) });
    expect((await post(`${base}/${id}/stop`)).status).toBe(409);

    expect(await post(`${base}/${id}/discard`)).toEqual({ status: 200, body: { id, created: [] } });
    expect(existsSync(join(root, DRAFTS_DIR, id))).toBe(false);
    expect((await get(`${base}/${id}`)).status).toBe(404);
    expect((await post(`${base}/${id}/discard`)).status).toBe(404);
  });

  it("runs one issue writer per project at a time", async () => {
    const { base, post, start, done } = setup([{ output: SINGLE, sleepMs: 60_000 }, { output: SINGLE }]);
    const first = await start("a slow idea");

    expect(await post(base, { idea: "another idea" })).toEqual({
      status: 409,
      body: { error: `The issue writer is already writing ${first} for demo. Wait for it, or stop it first.` },
    });

    await post(`${base}/${first}/stop`);
    await done(first);
    const second = await start("another idea");
    expect(await done(second)).toMatchObject({ kind: "waiting" });
  });

  it("limits each draft route that touches the files, counting only requests that pass the token check", async () => {
    const { app, base, get, post } = setup([], "human", { draftLimit: { max: 2, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "GET", url: "/api/drafts", headers: { host: HOST } })).statusCode).toBe(401);

    expect((await get("/api/drafts")).status).toBe(200);
    expect((await get("/api/drafts")).status).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/api/drafts", headers: HEADERS });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toEqual({ error: "Too many requests; try again in 60 s." });

    // Each route has its own count.
    expect((await get(`${base}/draft-00000000`)).status).toBe(404);
    expect((await post(base, { idea: " " })).status).toBe(400);
    expect((await post(`${base}/draft-00000000/discard`)).status).toBe(404);
    expect((await post(`${base}/draft-00000000/discard`)).status).toBe(404);
    expect((await post(`${base}/draft-00000000/discard`)).status).toBe(429);
  });

  it("stops a running issue writer when the server closes", async () => {
    const { app, start, done } = setup([{ output: SINGLE, sleepMs: 60_000 }]);
    const id = await start("a slow idea");
    await app.close();
    expect(await done(id)).toMatchObject({ kind: "failed" });
  });

  it("refuses to save or publish a draft git tracks, and says why", async () => {
    const { root, base, get, post, start, done, created } = setup([{ output: SINGLE }]);
    const id = await start("an idea");
    await done(id);
    runCommand("git", ["add", "-f", join(DRAFTS_DIR, id, "draft.md")], { cwd: root });

    const detail = await get<DraftDetail>(`${base}/${id}`);
    expect(detail.body.pending!.refusal).toMatch(/draft\.md is tracked by git/);
    const saved = await post(`${base}/${id}/save`, editOf("Other"));
    expect(saved.status).toBe(400);
    expect(saved.body.error).toMatch(/cannot be saved: .*tracked by git/);
    const published = await post(`${base}/${id}/publish`);
    expect(published.status).toBe(400);
    expect(published.body.error).toMatch(/cannot be created: .*tracked by git/);
    expect(created).toEqual([]);
    expect(readFileSync(join(root, DRAFTS_DIR, id, "draft.md"), "utf8")).toBe(SINGLE);
  });

  it("answers 404 for anything but a pending draft's exact id, and refuses an empty idea", async () => {
    const { root, base, get, post, start, done } = setup([{ output: SINGLE }]);
    const id = await start("an idea");
    await done(id);

    for (const ref of ["..%2Fx", "%2E%2E%2F%2E%2E%2Fpackage.json", "draft-", id.slice(0, 9), `${id}x`, "%2E%2E", encodeURIComponent(join(root, DRAFTS_DIR, id))]) {
      expect((await get(`${base}/${ref}`)).status, ref).toBe(404);
      for (const action of ["save", "publish", "discard"]) {
        expect((await post(`${base}/${ref}/${action}`, editOf("T"))).status, `${action} ${ref}`).toBe(404);
      }
    }
    expect(existsSync(join(root, DRAFTS_DIR, id, "draft.md"))).toBe(true);
    expect((await get(`/api/projects/nope/drafts/${id}`)).status).toBe(404);

    expect(await post(base, { idea: "  " })).toEqual({ status: 400, body: { error: "Say what the issue is about (idea)." } });
    expect(await post(base, { idea: "x", queue: "yes" })).toEqual({ status: 400, body: { error: "queue must be true or false." } });
  });

  it("goes through the token and Origin checks", async () => {
    const { app, base } = setup([]);
    expect((await app.inject({ method: "GET", url: "/api/drafts", headers: { host: HOST } })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: base, payload: { idea: "x" }, headers: { ...HEADERS, origin: "https://evil.example" } });
    expect(res.statusCode).toBe(403);
  });
});
