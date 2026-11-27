import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { auditsDir, Store, type AuditPort, type AuditRecord, type ProjectContext } from "@factory/core";
import { factoryConfigSchema } from "@factory/shared";
import { afterEach, describe, expect, it } from "vitest";
import { EventHub, type Published } from "./hub.js";
import { ProjectSet, projectKey } from "./projects.js";
import { createServer, type ServerOptions } from "./server.js";

const TOKEN = "a".repeat(64);
const HOST = "127.0.0.1:4180";
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

let repos = 0;
/** A project with its own GitHub repo name, so its audits don't mix with another test's. */
function project(schedule: "off" | "weekly" = "weekly"): ProjectContext {
  const path = join(mkdtempSync(join(tmpdir(), "factory-audits-")), "demo");
  const store = new Store(":memory:");
  const row = store.upsertProject({ name: "demo", repo_path: path, github_repo: `o/audits-${process.pid}-${repos++}` });
  return { root: path, config: factoryConfigSchema.parse({ version: 1, security: { audit_schedule: schedule } }), store, project: row };
}

const audit = (ctx: ProjectContext, patch: Partial<AuditRecord> = {}): AuditRecord => {
  const record: AuditRecord = {
    id: "20261127-103000",
    started_at: "2026-11-27T10:30:00.000Z",
    finished_at: "2026-11-27T10:45:00.000Z",
    commit: "abc123def4567890",
    effort: "medium",
    status: "complete",
    findings: [{ id: "security-scan-1a2b3c4d", severity: "critical", claim: "Command injection in ping", evidence: `host goes to execSync in ${join(homedir(), "x.js")}`, file: "server.js", line: 7 }],
    notes: [`see ${join(ctx.root, "scan")}`],
    filed: {},
    ...patch,
  };
  const dir = join(auditsDir(ctx.project), record.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "audit.json"), JSON.stringify(record));
  return record;
};

function server(ctx: ProjectContext, options: Partial<ServerOptions> = {}) {
  const hub = new EventHub();
  const published: Published[] = [];
  hub.subscribe((e) => published.push(e));
  const projects = new ProjectSet(
    () => [{ path: ctx.root, name: ctx.project.name, added_at: "t" }],
    () => ctx,
  );
  const app = createServer({ projects, hub, token: TOKEN, port: 4180, log: () => {}, ...options });
  apps.push(app);
  const key = projectKey(ctx.root);
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url: `/api/projects/${key}${url}`, headers: { host: HOST, "x-factory-token": TOKEN, ...(method === "POST" ? { origin: `http://${HOST}` } : {}) }, ...(method === "POST" ? { payload: payload ?? {} } : {}) });
  return { call, published };
}

function scheduler() {
  const requested: string[] = [];
  let state: { state: "running" | "failed"; error?: string } | undefined;
  return {
    requested,
    set: (next: typeof state) => (state = next),
    status: () => ({ running: [], limited: [], audits: state ? [{ project: "demo", path: requested[0]!, ...state }] : [] }),
    requestAudit: (path: string) => {
      if (requested.includes(path)) return "An audit of this project is already waiting for a free slot.";
      requested.push(path);
      return undefined;
    },
  };
}

describe("audit routes", () => {
  it("lists the project's audits and shows one with its findings, with local paths left out", async () => {
    const ctx = project();
    audit(ctx);
    const { call } = server(ctx);

    expect((await call("GET", "/audits")).json()).toEqual({
      schedule: "weekly",
      github: ctx.project.github_repo,
      audits: [
        { id: "20261127-103000", startedAt: "2026-11-27T10:30:00.000Z", finishedAt: "2026-11-27T10:45:00.000Z", commit: "abc123def4567890", effort: "medium", status: "complete", notes: ["see scan"], findings: 1 },
      ],
    });
    const detail = (await call("GET", "/audits/20261127-103000")).json();
    expect(detail.findings).toEqual([
      { id: "security-scan-1a2b3c4d", severity: "critical", claim: "Command injection in ping", evidence: expect.stringMatching(/^host goes to execSync in ~[\\/]x\.js$/), file: "server.js", line: 7 },
    ]);
    expect((await call("GET", "/audits/20200101-000000")).json()).toEqual({ error: "No such audit: it may have been removed." });
  });

  it("leaves local paths out of the claim and file too", async () => {
    const ctx = project();
    audit(ctx, { findings: [{ id: "f1", severity: "major", claim: `writes into ${join(ctx.root, "tmp")}`, evidence: "e", file: join(ctx.root, "server.js") }] });
    const { call } = server(ctx);
    const [finding] = (await call("GET", "/audits/20261127-103000")).json().findings;
    expect(finding.claim).not.toContain(ctx.root);
    expect(finding.file).not.toContain(ctx.root);
  });

  it("asks the scheduler for an audit now, once, and says when it can't", async () => {
    const ctx = project("off");
    const s = scheduler();
    const { call, published } = server(ctx, { scheduler: s });

    const asked = await call("POST", "/audits");
    expect(asked.statusCode).toBe(202);
    expect(asked.json()).toEqual({ state: "requested" });
    expect(s.requested).toEqual([ctx.root]);
    expect(published.map((p) => p.event)).toContainEqual({ type: "changed", project: projectKey(ctx.root) });
    expect((await call("POST", "/audits")).json()).toEqual({ error: "An audit of this project is already waiting for a free slot." });
    s.set({ state: "running" });
    expect((await call("GET", "/audits")).json()).toMatchObject({ schedule: "off", state: "running" });
    // An audit that couldn't start leaves nothing on disk: the page hears why from the scheduler.
    s.set({ state: "failed", error: `git fetch failed in ${ctx.root}` });
    const listed = (await call("GET", "/audits")).json();
    expect(listed.state).toBeUndefined();
    expect(listed.failed).toBe("git fetch failed in .");

    const none = server(project()).call;
    expect((await none("POST", "/audits")).json()).toEqual({ error: "Audits run in the scheduler, which isn't running." });
  });

  it("files a finding, asking first on a public repository", async () => {
    const ctx = project();
    audit(ctx);
    const issues: string[] = [];
    let visibility: "public" | "private" = "public";
    const port: AuditPort = { repoVisibility: () => visibility, createIssue: ({ title }) => (issues.push(title), 31) };
    const { call } = server(ctx, { auditPort: () => port });
    const file = "/audits/20261127-103000/findings/security-scan-1a2b3c4d/file";

    const refused = await call("POST", file);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "public_repo", error: expect.stringMatching(/is public: an issue would disclose/) });
    expect(issues).toEqual([]);

    expect((await call("POST", file, { public: true })).json()).toEqual({ issue: 31 });
    expect((await call("GET", "/audits/20261127-103000")).json().findings[0].issue).toBe(31);
    visibility = "private";
    const again = await call("POST", file);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "security-scan-1a2b3c4d is already filed as issue #31." });
    expect(issues).toHaveLength(1);
  });

  it("limits how often a page can ask for audits", async () => {
    const ctx = project();
    const { call } = server(ctx, { scheduler: scheduler(), auditLimit: { max: 1, windowMs: 60_000 } });
    expect((await call("POST", "/audits")).statusCode).toBe(202);
    expect((await call("POST", "/audits")).statusCode).toBe(429);
  });
});
