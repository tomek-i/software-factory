import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { driveIssue, loadConfig, Store, type CommandRunner, type ProjectContext } from "@factory/core";
import { factoryConfigSchema } from "@factory/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup, TRIAGE } from "../../../packages/core/test/driver-setup.js";
import { GIT_TEST_TIMEOUT, tempDir } from "../../../packages/core/test/helpers.js";
import { EventHub, type Published } from "./hub.js";
import { projectKey, ProjectSet } from "./projects.js";
import { createServer, type ServerOptions } from "./server.js";

const TOKEN = "a".repeat(64);
const PORT = 4180;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const AUTH = { "x-factory-token": TOKEN };

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** A project with an in-memory store and no repo behind it: enough for the routes that only read and write the store. */
function memoryProject(name = "demo", path = join(tempDir(), name)): ProjectContext {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name, repo_path: path, github_repo: "o/r" });
  const config = factoryConfigSchema.parse({ version: 1, trust: { authors: ["alice"] } });
  return { root: path, config, store, project };
}

function issue(ctx: ProjectContext, number: number, author = "alice") {
  ctx.store.upsertIssue(ctx.project.id, {
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    author,
    labels: [],
    url: `https://github.com/o/r/issues/${number}`,
    gh_updated_at: "2026-01-01T00:00:00Z",
  });
}

function server(contexts: ProjectContext[], options: Partial<ServerOptions> = {}) {
  const hub = new EventHub();
  const byPath = new Map(contexts.map((c) => [c.root, c]));
  const projects = new ProjectSet(
    () => contexts.map((c) => ({ path: c.root, name: c.project.name, added_at: "t" })),
    (entry) => byPath.get(entry.path)!,
  );
  const app = createServer({ projects, hub, token: TOKEN, port: PORT, log: () => {}, ...options });
  apps.push(app);
  return { app, hub };
}

/** A request from the app's own tab: the right Host, the session token and, for changes, its Origin. */
function call(app: ReturnType<typeof createServer>, method: "GET" | "POST", url: string, payload?: object) {
  return app.inject({
    method,
    url,
    headers: { host: HOST, ...AUTH, ...(method === "POST" ? { origin: ORIGIN } : {}) },
    ...(method === "POST" ? { payload: payload ?? {} } : {}),
  });
}

describe("security", () => {
  it("answers only its own Host, so a rebound DNS name can't reach it", async () => {
    const { app } = server([memoryProject()]);
    for (const host of ["evil.example:4180", "127.0.0.1:9999", "localhost", "127.0.0.1"]) {
      const res = await app.inject({ method: "GET", url: "/api/projects", headers: { host, ...AUTH } });
      expect(res.statusCode, String(host)).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/api/projects", headers: { host: `localhost:${PORT}`, ...AUTH } })).statusCode).toBe(200);
  });

  it("needs the session token for every API call", async () => {
    const { app } = server([memoryProject()]);
    expect((await app.inject({ method: "GET", url: "/api/projects", headers: { host: HOST } })).statusCode).toBe(401);
    const wrong = await app.inject({ method: "GET", url: "/api/projects", headers: { host: HOST, "x-factory-token": "b".repeat(64) } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: "Open the link `factory serve` printed." });
    expect((await app.inject({ method: "GET", url: "/api/events", headers: { host: HOST } })).statusCode).toBe(401);
  });

  it("refuses a change without this server's own Origin, even with the token", async () => {
    const ctx = memoryProject();
    issue(ctx, 5);
    const { app } = server([ctx]);
    const url = `/api/projects/${projectKey(ctx.root)}/issues/5/unqueue`;
    for (const origin of [undefined, "https://evil.example", "http://127.0.0.1:9999"]) {
      const res = await app.inject({ method: "POST", url, payload: {}, headers: { host: HOST, ...AUTH, ...(origin ? { origin } : {}) } });
      expect(res.statusCode, String(origin)).toBe(403);
    }
    expect((await call(app, "POST", url)).statusCode).toBe(200);
  });

  it("can't be talked out of the token by spelling an API path differently", async () => {
    const ctx = memoryProject();
    issue(ctx, 5);
    ctx.store.setQueued(ctx.project.id, 5, true);
    const { app } = server([ctx]);
    const key = projectKey(ctx.root);

    for (const url of ["/%61pi/projects", "/%61pi/scheduler", "/%61pi/events", "/api/%70rojects", "/%2561pi/projects", "//api/projects", "/API/projects"]) {
      const res = await app.inject({ method: "GET", url, headers: { host: HOST } });
      // Refused, or the app's page (which holds nothing of the user's): never data.
      expect(res.statusCode === 401 || res.body === "The web app is not built. Run `pnpm build`.", url).toBe(true);
    }
    const post = await app.inject({ method: "POST", url: `/%61pi/projects/${key}/issues/5/unqueue`, payload: {}, headers: { host: HOST, origin: ORIGIN } });
    expect(post.statusCode).toBe(401);
    expect(ctx.store.getIssue(ctx.project.id, 5)?.queued_at).not.toBeNull();
  });

  it("refuses a request line with an absolute URL", async () => {
    const { app } = server([memoryProject()], { port: 0 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;

    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.end(`GET http://127.0.0.1:${port}/api/projects HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });

    expect(raw.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
  });

  it("keeps the token out of cookies and referrers", async () => {
    const { app } = server([memoryProject()]);
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: { host: HOST, ...AUTH } });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves the app without the token, falls back to it for its screens, and can't be framed", async () => {
    const webRoot = tempDir();
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>factory</title>");
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");
    const { app } = server([memoryProject()], { webRoot });

    for (const url of ["/", "/inbox", "/runs?view=all"]) {
      const res = await app.inject({ method: "GET", url, headers: { host: HOST } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain("<title>factory</title>");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    }
    const js = await app.inject({ method: "GET", url: "/assets/app.js", headers: { host: HOST } });
    expect(js.body).toBe("console.log(1)");
    const missing = await call(app, "GET", "/api/nothing");
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Not found." });
  });

  it("keeps unexpected errors' details in the terminal", async () => {
    const lines: string[] = [];
    const hub = new EventHub();
    const projects = new ProjectSet(
      () => [{ path: "/repo", name: "demo", added_at: "t" }],
      () => {
        throw new Error("disk on fire at C:\\Users\\someone\\secret");
      },
    );
    const app = createServer({ projects, hub, token: TOKEN, port: PORT, log: (l) => lines.push(l) });
    apps.push(app);

    const res = await call(app, "GET", `/api/projects/${projectKey("/repo")}/issues`);

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
    expect(lines.join("\n")).toContain("disk on fire");
  });
});

describe("projects and the backlog", () => {
  it("lists the projects with their status", async () => {
    const ok = memoryProject("ok");
    mkdirSync(join(ok.root, ".factory"), { recursive: true });
    writeFileSync(join(ok.root, ".factory", "factory.db"), "");
    const gone = memoryProject("gone");
    const { app } = server([ok, gone]);

    expect((await call(app, "GET", "/api/projects")).json()).toEqual([
      { key: projectKey(ok.root), name: "ok", path: ok.root, status: "ok" },
      { key: projectKey(gone.root), name: "gone", path: gone.root, status: "missing_repo" },
    ]);
  });

  it("lists open issues with their place among the runs still to start, trust and latest run", async () => {
    const ctx = memoryProject();
    issue(ctx, 3);
    issue(ctx, 4, "mallory");
    issue(ctx, 5);
    issue(ctx, 6);
    issue(ctx, 7);
    // #6 was queued first but its run failed, #3's run is going on: neither waits to start.
    ctx.store.setQueued(ctx.project.id, 6, true);
    ctx.store.writeState(ctx.store.createRun({ project_id: ctx.project.id, title: "Issue 6", issue_number: 6 }).id, "failed");
    ctx.store.setQueued(ctx.project.id, 5, true);
    ctx.store.setQueued(ctx.project.id, 3, true);
    ctx.store.setQueued(ctx.project.id, 7, true);
    const run = ctx.store.createRun({ project_id: ctx.project.id, title: "Issue 3", issue_number: 3 });
    const { app } = server([ctx]);

    const res = await call(app, "GET", `/api/projects/${projectKey(ctx.root)}/issues`);

    expect(res.json()).toMatchObject({
      github: "o/r",
      syncedAt: expect.any(String),
      issues: [
        { number: 7, queued: true, position: 2 },
        { number: 6, queued: true, position: null, run: { state: "failed" } },
        { number: 5, queued: true, position: 1, trusted: true, run: null },
        { number: 4, queued: false, position: null, trusted: false, author: "mallory" },
        { number: 3, queued: true, position: null, run: { id: run.id, state: "intake", waitingGate: null } },
      ],
    });
  });

  it("queues an issue, fetching it first, and unqueues it, telling the event streams", async () => {
    const ctx = memoryProject();
    const gh: CommandRunner = (cmd, args) => {
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") {
        const json = { number: 9, title: "Issue 9", body: "", state: "OPEN", author: { login: "mallory" }, labels: [], url: "https://github.com/o/r/issues/9", updatedAt: "2026-01-01T00:00:00Z" };
        return { code: 0, stdout: JSON.stringify(json), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const { app, hub } = server([ctx], { run: gh });
    const seen: Published[] = [];
    hub.subscribe((p) => seen.push(p));
    const key = projectKey(ctx.root);

    const queued = await call(app, "POST", `/api/projects/${key}/issues/9/queue`);
    expect(queued.json()).toEqual({ number: 9, queued: true, trusted: false });
    expect(ctx.store.getIssue(ctx.project.id, 9)?.queued_at).not.toBeNull();

    const unqueued = await call(app, "POST", `/api/projects/${key}/issues/9/unqueue`);
    expect(unqueued.json()).toEqual({ number: 9, queued: false });
    expect(ctx.store.getIssue(ctx.project.id, 9)?.queued_at).toBeNull();
    expect(seen.map((p) => p.event)).toEqual([
      { type: "changed", project: key },
      { type: "changed", project: key },
    ]);

    expect((await call(app, "POST", `/api/projects/${key}/issues/77/unqueue`)).statusCode).toBe(404);
    expect((await call(app, "POST", `/api/projects/${key}/issues/abc/queue`)).json()).toEqual({ error: '"abc" is not an issue number.' });
    const failed = await call(app, "POST", `/api/projects/${key}/issues/10/queue`);
    expect(failed.statusCode).toBe(400);
    expect(failed.json().error).toMatch(/^Could not fetch issue #10/);
    expect((await call(app, "GET", "/api/projects/nope/issues")).statusCode).toBe(404);
  });

  it("syncs issues from GitHub and reports what changed", async () => {
    const ctx = memoryProject();
    issue(ctx, 1);
    const gh: CommandRunner = (cmd, args) => {
      if (cmd === "gh" && args[0] === "issue" && args[1] === "list") {
        const json = [{ number: 2, title: "Issue 2", body: "", state: "OPEN", author: { login: "alice" }, labels: [], url: "https://github.com/o/r/issues/2", updatedAt: "2026-01-02T00:00:00Z" }];
        return { code: 0, stdout: JSON.stringify(json), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const { app } = server([ctx], { run: gh, github: () => ({ pullRequestState: () => { throw new Error("no PRs"); } }) as never });

    const res = await call(app, "POST", `/api/projects/${projectKey(ctx.root)}/sync`);

    expect(res.json()).toMatchObject({ open: 1, closed: 1, queued: 0 });
    expect(ctx.store.listIssues({ project_id: ctx.project.id, state: "open" }).map((i) => i.number)).toEqual([2]);
  });

  it("reports a GitHub failure on sync as such", async () => {
    const ctx = memoryProject();
    const { app } = server([ctx], { run: () => ({ code: 1, stdout: "", stderr: "gh: not logged in" }) });

    const res = await call(app, "POST", `/api/projects/${projectKey(ctx.root)}/sync`);

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("not logged in");
  });
});

describe("runs", () => {
  it("lists active, waiting and all runs across projects, newest change first", async () => {
    const a = memoryProject("a");
    const b = memoryProject("b");
    const waiting = a.store.createRun({ project_id: a.project.id, title: "Waits", issue_number: 1 });
    a.store.writeState(waiting.id, "needs_human", { parked_from: "build" });
    a.store.appendEvent(waiting.id, "build", "needs_human", "the build agent failed");
    const done = b.store.createRun({ project_id: b.project.id, title: "Done", issue_number: 2 });
    b.store.writeState(done.id, "done");
    const going = b.store.createRun({ project_id: b.project.id, title: "Builds", issue_number: 3 });
    b.store.writeState(going.id, "build");
    const { app } = server([a, b]);

    const ids = async (query: string) => ((await call(app, "GET", `/api/runs${query}`)).json() as { id: string }[]).map((r) => r.id).sort();
    expect(await ids("")).toEqual([waiting.id, going.id].sort());
    expect(await ids("?view=waiting")).toEqual([waiting.id]);
    expect(await ids("?view=all")).toEqual([waiting.id, done.id, going.id].sort());
    expect(await ids(`?view=all&project=${projectKey(b.root)}`)).toEqual([done.id, going.id].sort());
    expect((await call(app, "GET", "/api/runs?view=odd")).statusCode).toBe(400);

    const [row] = (await call(app, "GET", "/api/runs?view=waiting")).json();
    expect(row).toEqual({
      project: projectKey(a.root),
      projectName: "a",
      id: waiting.id,
      issue: 1,
      title: "Waits",
      state: "needs_human",
      waitingGate: null,
      build: 1,
      review: 1,
      cost: 0,
      held: false,
      updatedAt: expect.any(String),
      reason: "the build agent failed",
      resumeTargets: expect.arrayContaining(["build"]),
    });
  });

  it(
    "approves a waiting gate, leaving the run for the scheduler, and rejects and cancels with the service's rules",
    async () => {
      const s = setup([{ output: TRIAGE() }, { output: TRIAGE() }], {
        config: "version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n",
      });
      const ctx: ProjectContext = { root: s.root, store: s.store, project: s.project, config: loadConfig(s.root) };
      const { run } = await driveIssue(ctx, 12, {}, { owner: "test-server", env: s.fake.env, github: s.github });
      expect(run).toMatchObject({ state: "needs_human", waiting_gate: "triage" });
      const { app } = server([ctx]);
      const base = `/api/projects/${projectKey(s.root)}/runs`;

      const atTriage = { state: "needs_human", gate: "triage" };
      expect((await call(app, "POST", `${base}/nope/approve`, atTriage)).statusCode).toBe(404);
      const noReason = await call(app, "POST", `${base}/${run.id}/reject`, { ...atTriage, message: " " });
      expect(noReason.statusCode).toBe(400);
      expect(noReason.json()).toEqual({ error: "Say why with -m." });
      expect((await call(app, "POST", `${base}/${run.id}/approve`, { ...atTriage, message: 5 })).json()).toEqual({ error: "message must be text." });
      expect((await call(app, "POST", `${base}/${run.id}/approve`, { message: "go" })).json()).toEqual({ error: "Say which state the run was in (state)." });
      // The page showed another gate than the one the run waits at now: nothing is decided.
      const stale = await call(app, "POST", `${base}/${run.id}/approve`, { state: "needs_human", gate: "merge" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe(`Run ${run.id} has moved on: it is needs_human at the triage gate now. Look again before deciding.`);
      expect(s.store.getRun(run.id)?.state).toBe("needs_human");

      const approved = await call(app, "POST", `${base}/${run.id}/approve`, { ...atTriage, message: "go" });
      expect(approved.json()).toMatchObject({ run: { id: run.id, state: "build", lease_owner: null }, gate: "triage", to: "build", continuation: "ready" });
      expect(s.store.listDecisions(run.id).at(-1)).toMatchObject({ gate: "triage", comment: "go" });
      expect((await call(app, "POST", `${base}/${run.id}/approve`, atTriage)).statusCode).toBe(409);
      expect((await call(app, "POST", `${base}/${run.id}/approve`, { state: "build" })).json().error).toMatch(/is not waiting at a gate \(it is build\)/);

      const cancelled = await call(app, "POST", `${base}/${run.id}/cancel`, { state: "build" });
      expect(cancelled.json()).toMatchObject({ run: { state: "cancelled" }, stopped: 0 });
      expect(s.store.listEvents(run.id).at(-1)?.reason).toContain("cancelled from the web");

      // A second run of the same issue, parked at triage again, then rejected.
      const second = await driveIssue(ctx, 12, {}, { owner: "test-server", env: s.fake.env, github: s.github });
      const rejected = await call(app, "POST", `${base}/${second.run.id}/reject`, { ...atTriage, message: "not now" });
      expect(rejected.json()).toMatchObject({ run: { state: "rejected" }, gate: "triage" });

      const resumed = await call(app, "POST", `${base}/${second.run.id}/resume`, { state: "rejected", to: "build", message: "go" });
      expect(resumed.json().error).toMatch(/is not waiting for you/);
    },
    GIT_TEST_TIMEOUT,
  );

  it("reports the scheduler's state", async () => {
    const status = { running: [{ project: "demo", issue: 3 }], pausedUntil: "2026-11-16T12:00:00.000Z" };
    const { app } = server([memoryProject()], { scheduler: { status: () => status } });
    expect((await call(app, "GET", "/api/scheduler")).json()).toEqual(status);
  });
});

describe("events", () => {
  it("streams the hub's events to a browser, and closing ends the stream", async () => {
    const { app, hub } = server([memoryProject()], { port: 0, heartbeatMs: 30 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { ...AUTH } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const until = async (text: string) => {
      while (!received.includes(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${text}: ${received}`);
        received += decoder.decode(value);
      }
    };
    await until(": connected");
    await vi.waitFor(() => expect(hub.size).toBe(1));

    hub.publish({ type: "resumed" });
    hub.publish({ type: "changed", project: "abc" });
    await until('"project":"abc"');
    expect(received).toContain('id: 1\ndata: {"type":"resumed"}\n\n');
    expect(received).toContain('id: 2\ndata: {"type":"changed","project":"abc"}\n\n');
    await until(": ping");

    await app.close();
    expect(hub.size).toBe(0);
    // Interrupted runs keep publishing while the server closes; nothing writes to the ended stream.
    expect(() => hub.publish({ type: "resumed" })).not.toThrow();
  });
});
