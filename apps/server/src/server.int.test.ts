import { mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { driveIssue, loadConfig, runDirOf, Store, type CommandRunner, type GithubPort, type ProjectContext, type PullRequestCheck } from "@factory/core";
import { factoryConfigSchema } from "@factory/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup, TRIAGE } from "../../../packages/core/test/driver-setup.js";
import { GIT_TEST_TIMEOUT, tempDir } from "../../../packages/core/test/helpers.js";
import { EventHub, type Published } from "./hub.js";
import { GITHUB_TTL_MS } from "./merge-gate.js";
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
      pr: null,
      build: 1,
      review: 1,
      resyncs: 0,
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

  describe("sending a waiting run back, and its failed checks", () => {
    /** A real repo (the service reads the trusted config) with a run of issue 12 waiting as given. */
    function waiting(patch: Parameters<Store["writeState"]>[2], reason: string, data?: unknown) {
      const s = setup([]);
      const ctx: ProjectContext = { root: s.root, store: s.store, project: s.project, config: loadConfig(s.root) };
      const run = s.store.createRun({ project_id: s.project.id, title: "t", issue_number: 12 });
      s.store.writeState(run.id, "needs_human", patch);
      s.store.appendEvent(run.id, patch?.parked_from ?? null, "needs_human", reason, data);
      const { app } = server([ctx], { github: () => s.github });
      return { s, ctx, run, app, base: `/api/projects/${projectKey(s.root)}/runs/${run.id}` };
    }

    it(
      "offers a run at a gate the earlier working stages, says which cap stopped it and what failed, without a local path",
      async () => {
        const { s, run, app, base } = waiting(
          { parked_from: "review", waiting_gate: "review", round: 3 },
          "waiting at review gate: reviews still have confirmed findings after round 3: review round cap reached (3)",
        );
        mkdirSync(join(runDirOf(s.root, run.id), "round-3"), { recursive: true });
        const verify = `VERDICT: CONFIRMED\n\n## Findings\n\`\`\`json\n[{"id":"code-1","severity":"major","file":${JSON.stringify(join(s.root, "src", "a.ts"))},"line":12,"claim":${JSON.stringify(`skips ${join(homedir(), "x")}`)},"evidence":"e"}]\n\`\`\`\n`;
        writeFileSync(join(runDirOf(s.root, run.id), "round-3", "verify.md"), verify);

        const res = await call(app, "GET", base);

        expect(res.json().run).toMatchObject({
          resumeTargets: ["refine", "build"],
          capReached: "review round cap reached (3)",
          failure: {
            kind: "findings",
            source: "round-3/verify.md",
            items: [{ name: "code-1 (major)", summary: `skips ${join("~", "x")}`, file: join("src", "a.ts"), line: 12 }],
          },
        });
        const [row] = (await call(app, "GET", "/api/runs?view=waiting")).json();
        expect(row.failure.items[0].file).toBe(join("src", "a.ts"));
      },
      GIT_TEST_TIMEOUT,
    );

    it(
      "resumes a run waiting at a gate to an earlier stage with fresh loops, through the same checks as the other actions",
      async () => {
        const { s, run, app, base } = waiting({ parked_from: "review", waiting_gate: "review", review_rounds: 2, build_iterations: 1 }, "review round cap reached (3)");
        const shown = { state: "needs_human", gate: "review" };

        const noOrigin = await app.inject({ method: "POST", url: `${base}/resume`, payload: { ...shown, to: "build", message: "fix it" }, headers: { host: HOST, ...AUTH } });
        expect(noOrigin.statusCode).toBe(403);
        expect((await call(app, "POST", `${base}/resume`, { state: "needs_human", to: "build", message: "fix it" })).statusCode).toBe(409);
        const odd = await call(app, "POST", `${base}/resume`, { ...shown, to: "build", message: "fix it", resetLoops: "yes" });
        expect(odd.statusCode).toBe(400);
        expect(odd.json()).toEqual({ error: "resetLoops must be true or false." });
        const refused = await call(app, "POST", `${base}/resume`, { ...shown, to: "merge", message: "ship" });
        expect(refused.statusCode).toBe(400);
        expect(refused.json().error).toMatch(/can resume to: .*build/);
        expect((await call(app, "POST", `${base}/resume`, { ...shown, to: "build", message: " " })).json()).toEqual({ error: "Say why with -m." });
        expect(s.store.getRun(run.id)).toMatchObject({ state: "needs_human", review_rounds: 2 });

        const resumed = await call(app, "POST", `${base}/resume`, { ...shown, to: "build", message: "code-1: the limiter is skipped", resetLoops: true });

        expect(resumed.json()).toMatchObject({ run: { state: "build", review_rounds: 0, build_iterations: 0 }, to: "build", continuation: "ready" });
        expect(s.store.listEvents(run.id).at(-1)).toMatchObject({ reason: "human: code-1: the limiter is skipped", data: { gate: "review", resetLoops: true } });
      },
      GIT_TEST_TIMEOUT,
    );

    it(
      "lists a run's failed checks with their alerts, and dismisses one, going back to merge once the check passes",
      async () => {
        const { s, run, app, base } = waiting({ parked_from: "merge", pr_number: 7 }, "required check failed on PR #7: CodeQL", { failedChecks: [{ name: "CodeQL" }] });
        const alert = (number: number) => ({ number, rule: "js/missing-rate-limiting", description: "Missing rate limiting", severity: "high", tool: "CodeQL", url: `https://gh/a/${number}` });
        s.pr.alerts = [alert(26), alert(27)];
        s.pr.checks = [[{ name: "CodeQL", bucket: "fail" }]];
        s.pr.checksWhenClear = [{ name: "CodeQL", bucket: "pass" }];
        const shown = { state: "needs_human" };

        expect((await call(app, "GET", base)).json().run.failure).toEqual({ kind: "checks", items: [{ name: "CodeQL" }] });
        expect((await call(app, "GET", `${base}/checks`)).json()).toEqual({ pr: 7, failed: [{ name: "CodeQL", alerts: [alert(26), alert(27)] }], otherAlerts: [] });
        expect((await app.inject({ method: "GET", url: `${base}/checks`, headers: { host: HOST } })).statusCode).toBe(401);

        expect((await call(app, "POST", `${base}/dismiss`, { ...shown, alert: "26", reason: "false positive", comment: "x" })).json()).toEqual({ error: "alert must be an alert number." });
        expect((await call(app, "POST", `${base}/dismiss`, { state: "merge", alert: 26, reason: "false positive", comment: "x" })).statusCode).toBe(409);
        expect((await call(app, "POST", `${base}/dismiss`, { ...shown, alert: 26, reason: "false positive", comment: "" })).json()).toEqual({ error: "Say why with -m." });
        expect(s.dismissals).toEqual([]);

        const first = await call(app, "POST", `${base}/dismiss`, { ...shown, alert: 26, reason: "false positive", comment: "a limiter covers it" });
        expect(first.json()).toMatchObject({ continued: false, failing: ["CodeQL"], run: { state: "needs_human" } });
        const second = await call(app, "POST", `${base}/dismiss`, { ...shown, alert: 27, reason: "used in tests", comment: "test fixture" });
        expect(second.json()).toMatchObject({ continued: true, failing: [], continuation: "ready", run: { state: "merge" } });
        expect(s.store.listDecisions(run.id).map((d) => d.actor)).toEqual(["human", "human", "human"]);
      },
      GIT_TEST_TIMEOUT,
    );
  });

  describe("details", () => {
    /** A run waiting at triage, with a run folder whose files quote the repo, the worktree and the home folder. */
    function detailed() {
      const ctx = memoryProject();
      issue(ctx, 12);
      const run = ctx.store.createRun({ project_id: ctx.project.id, title: "Run title", issue_number: 12 });
      const worktree = join(tempDir(), "worktree");
      ctx.store.writeState(run.id, "needs_human", { waiting_gate: "triage" });
      ctx.store.updateRunFields(run.id, { worktree_path: worktree });
      ctx.store.appendEvent(run.id, "triage", "needs_human", `triage rated the risk HIGH, see ${join(ctx.root, "src", "auth.ts")}`);
      const dir = runDirOf(ctx.root, run.id);
      mkdirSync(join(dir, "spec-1"), { recursive: true });
      writeFileSync(join(dir, "triage.md"), TRIAGE("APPROVE", `- touches ${join(worktree, "src", "x.ts")}\n`).replace("RISK: LOW", "RISK: HIGH"));
      writeFileSync(join(dir, "spec-1", "critic.md"), "not a verdict");
      writeFileSync(join(dir, "notes.md"), `<script>alert(1)</script>\nat ${join(homedir(), "secret.txt")} and ${join(ctx.root, "a.ts")}\n`);
      writeFileSync(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d]));
      const { app } = server([ctx]);
      return { ctx, run, worktree, dir, app, base: `/api/projects/${projectKey(ctx.root)}/runs/${run.id}` };
    }

    it("shows a run's row, issue, files and sections, without a local path", async () => {
      const { ctx, run, worktree, dir, app, base } = detailed();

      const res = await call(app, "GET", base);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        run: { id: run.id, state: "needs_human", waitingGate: "triage", reason: `triage rated the risk HIGH, see ${join("src", "auth.ts")}` },
        issue: { number: 12, title: "Issue 12", url: "https://github.com/o/r/issues/12" },
        hasRunDir: true,
        files: ["notes.md", "shot.png", "spec-1/critic.md", "triage.md"],
        sections: [
          { kind: "verdict", path: "triage.md", key: "DECISION", value: "APPROVE", summary: ["looks fine", `touches ${join("src", "x.ts")}`] },
          { kind: "unparsed", path: "spec-1/critic.md" },
        ],
      });
      for (const path of [dir, ctx.root, worktree, homedir()]) {
        expect(res.body).not.toContain(path);
        expect(res.body).not.toContain(JSON.stringify(path).slice(1, -1));
      }
      expect(body).not.toHaveProperty("runDir");
      expect(body.run).not.toHaveProperty("worktree_path");
    });

    it("shows the acceptance criteria per criterion, without a local path", async () => {
      const { ctx, worktree, dir, app, base } = detailed();
      mkdirSync(join(dir, "round-1"), { recursive: true });
      writeFileSync(join(dir, "round-1", "checks.md"), `GATE: PASS\nCOMMIT: ${"a".repeat(40)}\n`);
      const criteria = [{ id: "AC-1", source: "issue", text: "shows a run", status: "MET", evidence: `${join(worktree, "src", "x.test.ts")}` }];
      writeFileSync(join(dir, "round-1", "acceptance.json"), JSON.stringify({ criteria }));

      const res = await call(app, "GET", base);

      expect(res.json().sections).toContainEqual({
        kind: "acceptance",
        path: "round-1/acceptance.json",
        count: "1/1 met",
        criteria: [{ ...criteria[0], evidence: join("src", "x.test.ts") }],
      });
      expect(res.body).not.toContain(JSON.stringify(ctx.root).slice(1, -1));
    });

    it("serves one run file as redacted text, and only from inside the run folder", async () => {
      const { ctx, app, base } = detailed();

      const notes = await call(app, "GET", `${base}/files/notes.md`);
      expect(notes.statusCode).toBe(200);
      expect(notes.json()).toEqual({ path: "notes.md", text: `<script>alert(1)</script>\nat ${join("~", "secret.txt")} and a.ts\n` });
      expect(notes.body).not.toContain(ctx.root.replace(/\\/g, "\\\\"));
      expect((await call(app, "GET", `${base}/files/spec-1/critic.md`)).json()).toEqual({ path: "spec-1/critic.md", text: "not a verdict" });
      expect((await call(app, "GET", `${base}/files/triage`)).json().path).toBe("triage.md");

      for (const path of ["..%2Fx", "..%5Cx", "spec-1%2F..%2F..%2Fx", "%2Fetc%2Fpasswd", "C:%5CWindows%5Cwin.ini", encodeURIComponent(join(ctx.root, "package.json"))]) {
        const res = await call(app, "GET", `${base}/files/${path}`);
        expect(res.statusCode, path).toBe(400);
        expect(res.json().error, path).toMatch(/outside the run folder/);
      }
      // Dot segments in the URL itself are resolved before routing: they never reach the file route.
      for (const path of ["%2E%2E/x", "spec-1/%2E%2E/%2E%2E/x", "../../../../package.json"]) {
        expect((await call(app, "GET", `${base}/files/${path}`)).statusCode, path).toBe(404);
      }
      const missing = await call(app, "GET", `${base}/files/nope.md`);
      expect(missing.statusCode).toBe(400);
      expect(missing.body).not.toContain(ctx.root.replace(/\\/g, "\\\\"));
      expect((await call(app, "GET", `${base}/files/shot.png`)).json()).toEqual({ error: '"shot.png" is not a text file.' });
    });

    it("answers 404 for an unknown run or one of another project, and goes through the token and Host checks", async () => {
      const { ctx, run, app, base } = detailed();
      const key = projectKey(ctx.root);

      for (const url of [base, `${base}/files/triage.md`]) {
        expect((await app.inject({ method: "GET", url, headers: { host: HOST } })).statusCode, url).toBe(401);
        expect((await app.inject({ method: "GET", url, headers: { host: "evil.example:4180", ...AUTH } })).statusCode, url).toBe(403);
      }
      for (const url of [`/api/projects/${key}/runs/nope`, `/api/projects/${key}/runs/nope/files/triage.md`, `/api/projects/${key}/runs/${run.id.slice(0, 4)}`, `/api/projects/${key}/runs/%2312`]) {
        const res = await call(app, "GET", url);
        expect(res.statusCode, url).toBe(404);
      }
    });

    it("shows a run without an issue or a run folder", async () => {
      const ctx = memoryProject();
      const run = ctx.store.createRun({ project_id: ctx.project.id, title: "Loose run" });
      const { app } = server([ctx]);

      const res = await call(app, "GET", `/api/projects/${projectKey(ctx.root)}/runs/${run.id}`);

      expect(res.json()).toMatchObject({ run: { id: run.id, state: "intake", issue: null }, issue: null, hasRunDir: false, files: [], sections: [] });
    });
  });

  describe("cleanup", () => {
    /** A run that just finished, its worktree and branch not cleaned up yet. No git runs on these paths. */
    function finished() {
      const ctx = memoryProject();
      const run = ctx.store.createRun({ project_id: ctx.project.id, title: "Done run", issue_number: 12 });
      ctx.store.updateRunFields(run.id, { worktree_path: join(ctx.root, ".worktrees", run.id), branch: "factory/12-done" });
      ctx.store.writeState(run.id, "cancelled");
      const { app } = server([ctx]);
      return { ctx, run, app, key: projectKey(ctx.root), base: `/api/projects/${projectKey(ctx.root)}/runs/${run.id}` };
    }

    it("shows a finished run's leftover worktree, relative to the repo, and its branch", async () => {
      const { run, app, base } = finished();
      expect((await call(app, "GET", base)).json().leftover).toEqual({ worktree: `.worktrees/${run.id}`, branch: "factory/12-done" });
    });

    it("cleans up one run only once it has finished and no worker holds it", async () => {
      const { ctx, run, app, base } = finished();
      ctx.store.acquireLease(run.id, "worker", 60_000);
      const held = await call(app, "POST", `${base}/cleanup`, { state: "cancelled" });
      expect(held.statusCode).toBe(400);
      expect(held.json()).toEqual({ error: `A worker still holds run ${run.id}; it cleans up once it has stopped.` });
      // Shown in another state than it is in now: refused before anything runs.
      expect((await call(app, "POST", `${base}/cleanup`, { state: "review" })).statusCode).toBe(409);
    });

    it("cleans up the project's finished runs and lists the ones it left alone", async () => {
      const { run, app, key } = finished();
      const res = await call(app, "POST", `/api/projects/${key}/cleanup`, {});
      expect(res.json()).toEqual({ lines: [], skipped: [{ runId: run.id, why: expect.stringMatching(/^finished \d+s ago; cleaned up 2 minutes after it finished$/), recent: true }] });
    });
  });

  describe("merge gate", () => {
    const REVIEW_PASS = "VERDICT: PASS\n\n## Findings\n```json\n[{ \"id\": \"c-1\", \"severity\": \"nit\", \"claim\": \"rename x\", \"evidence\": \"e\" }]\n```\n";
    const CHECKS = `GATE: PASS\nCOMMIT: ${"a".repeat(40)}\n`;

    /** A run waiting at the merge gate with PR #7, reviewed in round 1, and a fake GitHub that counts its calls. */
    function atMerge(checks: PullRequestCheck[][] = [[{ name: "test", bucket: "pass", link: "https://ci/1" }]]) {
      const ctx = memoryProject();
      const run = ctx.store.createRun({ project_id: ctx.project.id, title: "Merge me", issue_number: 12 });
      ctx.store.writeState(run.id, "needs_human", { waiting_gate: "merge", pr_number: 7, build_iterations: 1, review_rounds: 2 });
      ctx.store.appendEvent(run.id, "merge", "needs_human", "waiting at merge gate: gate is set to human", { reasons: ["gate is set to human"] });
      const dir = runDirOf(ctx.root, run.id);
      mkdirSync(join(dir, "round-1"), { recursive: true });
      writeFileSync(join(dir, "round-1", "checks.md"), CHECKS);
      writeFileSync(join(dir, "round-1", "review-code.md"), REVIEW_PASS);
      writeFileSync(join(dir, "round-1", "review-docs.md"), `not a verdict, see ${join(ctx.root, "x.md")}`);
      const calls = { factory: 0, diff: 0, checks: 0 };
      let head = "h1";
      let error: string | undefined;
      const github = {
        pullRequestDiff: (n: number) => {
          calls.diff++;
          if (error) throw new Error(error);
          expect(n).toBe(7);
          return { head, additions: 120, deletions: 40, changedFiles: 8 };
        },
        pullRequestChecks: () => checks[Math.min(calls.checks++, checks.length - 1)]!,
      } as unknown as GithubPort;
      let now = 1_000_000;
      const { app } = server([ctx], {
        github: () => {
          calls.factory++;
          return github;
        },
        clock: () => now,
      });
      return {
        ctx,
        run,
        app,
        calls,
        url: `/api/projects/${projectKey(ctx.root)}/runs/${run.id}/merge-gate`,
        later: (ms: number) => void (now += ms),
        moveHead: (to: string) => void (head = to),
        fail: (message?: string) => void (error = message),
      };
    }

    it("shows the PR, its diff, the head's checks, the reviews per lens, rounds and cost", async () => {
      const { ctx, app, url } = atMerge([
        [
          { name: "test", bucket: "pass", link: "https://ci/1" },
          { name: "CodeQL", bucket: "fail", link: "https://ci/2" },
          { name: "e2e", bucket: "cancel" },
          { name: "deploy", bucket: "pending" },
          { name: "docs", bucket: "skipping" },
        ],
      ]);

      const res = await call(app, "GET", url);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        pr: { number: 7, url: "https://github.com/o/r/pull/7", head: "h1", additions: 120, deletions: 40, changedFiles: 8 },
        checks: { passed: 1, failed: 2, pending: 1, skipped: 1, failedChecks: [{ name: "CodeQL", link: "https://ci/2" }, { name: "e2e" }] },
        reviews: [
          { lens: "code", path: "round-1/review-code.md", verdict: "PASS", findings: 1, blocking: 0 },
          { lens: "docs", path: "round-1/review-docs.md", problem: expect.any(String) },
        ],
        rounds: { build: 2, review: 3 },
        cost: 0,
      });
      expect(res.body).not.toContain(ctx.root.replace(/\\/g, "\\\\"));
    });

    it("reuses a head's settled checks, and asks again for pending ones, a moved head and an expired diff", async () => {
      const pending: PullRequestCheck[] = [{ name: "test", bucket: "pending" }];
      const passed: PullRequestCheck[] = [{ name: "test", bucket: "pass" }];
      const { app, url, calls, later, moveHead } = atMerge([pending, passed, passed]);

      expect((await call(app, "GET", url)).json().checks).toMatchObject({ pending: 1, passed: 0 });
      expect((await call(app, "GET", url)).json().checks).toMatchObject({ pending: 1 });
      expect(calls).toMatchObject({ diff: 1, checks: 1 });

      later(GITHUB_TTL_MS);
      expect((await call(app, "GET", url)).json().checks).toMatchObject({ pending: 0, passed: 1 });
      expect(calls).toMatchObject({ diff: 2, checks: 2 });
      // Settled on this head: only the diff lookup is repeated once it expires.
      later(GITHUB_TTL_MS * 10);
      await call(app, "GET", url);
      await call(app, "GET", url);
      expect(calls).toMatchObject({ diff: 3, checks: 2 });

      moveHead("h2");
      later(GITHUB_TTL_MS);
      expect((await call(app, "GET", url)).json().pr.head).toBe("h2");
      expect(calls).toMatchObject({ diff: 4, checks: 3 });
    });

    it("still answers with the rest when GitHub can't be read, and reads it again next time", async () => {
      const { app, url, calls, fail } = atMerge();
      fail("gh pr view failed: HTTP 502\nmore detail");

      const res = await call(app, "GET", url);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        pr: { number: 7, url: "https://github.com/o/r/pull/7" },
        checks: null,
        githubError: "gh pr view failed: HTTP 502",
        reviews: [{ lens: "code", verdict: "PASS" }, { lens: "docs" }],
        rounds: { build: 2, review: 3 },
      });
      expect(res.json().pr).not.toHaveProperty("additions");
      fail(undefined);
      expect((await call(app, "GET", url)).json()).toMatchObject({ pr: { additions: 120 }, checks: { passed: 1 } });
      expect(calls.diff).toBe(2);
    });

    it("never calls GitHub for the run lists, and has no details for runs not at the merge gate or without a PR", async () => {
      const { ctx, run, app, url, calls } = atMerge();

      const [row] = (await call(app, "GET", "/api/runs?view=waiting")).json();
      expect(row).toMatchObject({ id: run.id, waitingGate: "merge", pr: 7, reason: "waiting at merge gate: gate is set to human" });
      expect(calls.factory).toBe(0);

      const triage = ctx.store.createRun({ project_id: ctx.project.id, title: "At triage", issue_number: 13 });
      ctx.store.writeState(triage.id, "needs_human", { waiting_gate: "triage", pr_number: 8 });
      const building = ctx.store.createRun({ project_id: ctx.project.id, title: "Builds", issue_number: 14 });
      ctx.store.writeState(building.id, "build");
      for (const id of [triage.id, building.id, "nope"]) {
        expect((await call(app, "GET", url.replace(run.id, id))).statusCode, id).toBe(404);
      }
      expect((await app.inject({ method: "GET", url, headers: { host: HOST } })).statusCode).toBe(401);
      expect(calls.factory).toBe(0);

      ctx.store.updateRunFields(run.id, { pr_number: null });
      expect((await call(app, "GET", url)).json()).toMatchObject({ pr: null, checks: null, reviews: [{ lens: "code" }, { lens: "docs" }] });
      expect(calls.factory).toBe(0);
    });

    it("says so when the project has no GitHub repository", async () => {
      const ctx = memoryProject();
      const store = new Store(":memory:");
      const noRepo = { ...ctx, store, project: store.upsertProject({ name: "local", repo_path: ctx.root, github_repo: null }) };
      const run = noRepo.store.createRun({ project_id: noRepo.project.id, title: "Local", issue_number: 1 });
      noRepo.store.writeState(run.id, "needs_human", { waiting_gate: "merge", pr_number: 3 });
      const { app } = server([noRepo], { github: () => { throw new Error("not called"); } });

      const res = await call(app, "GET", `/api/projects/${projectKey(noRepo.root)}/runs/${run.id}/merge-gate`);

      expect(res.json()).toMatchObject({ pr: { number: 3, url: null }, checks: null, githubError: "This project has no GitHub repository." });
    });
  });

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
