import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { Store, type DriveFn, type ProjectContext, type StopRequest } from "@factory/core";
import { tempDir } from "../../../../packages/core/test/helpers.js";
import { CliError } from "../context.js";
import { parsePort, runServe } from "./serve.js";

const TOKEN = "c".repeat(64);

/** One project with a queued issue whose run parks at triage, and a serve that can be stopped from the test. */
function setup() {
  const store = new Store(":memory:");
  const row = store.upsertProject({ name: "shop", repo_path: "/repos/shop", github_repo: "acme/shop" });
  store.upsertIssue(row.id, { number: 12, title: "Add thing", body: "", state: "open", author: "alice", labels: [], url: "u", gh_updated_at: "2026-01-01T00:00:00Z" });
  store.setQueued(row.id, 12, true);
  const ctx: ProjectContext = { root: row.repo_path, config: factoryConfigSchema.parse({ version: 1 }), store, project: row };
  const lines: string[] = [];
  const opened: string[] = [];
  const browser: string[] = [];
  let stop: StopRequest | undefined;
  let listening: (url: string) => void = () => {};
  const url = new Promise<string>((resolve) => (listening = resolve));
  const drive: DriveFn = async (c, number) => {
    const run = c.store.createRun({ project_id: row.id, title: "Add thing", issue_number: number });
    c.store.writeState(run.id, "needs_human", { waiting_gate: "triage" });
    return { outcome: { kind: "parked", state: "needs_human", reason: "triage waits for you" }, run: c.store.getRun(run.id)! };
  };
  const deps = {
    print: (line: string) => lines.push(line),
    projects: () => [{ path: row.repo_path, name: "shop", added_at: "t" }],
    openProject: () => {
      opened.push(row.repo_path);
      return ctx;
    },
    reconcile: () => ["finished run abc: its PR was merged"],
    openBrowser: (u: string) => browser.push(u),
    onListening: (u: string) => listening(u),
    token: TOKEN,
    webRoot: tempDir(),
    scheduler: {
      trustedConfig: () => factoryConfigSchema.parse({ version: 1 }),
      fetchIssue: () => {},
      drive,
      stopRequest: () => stop,
      tickMs: 5,
    },
  };
  return { deps, lines, opened, browser, store, url, requestStop: (now = false) => (stop = { at: Date.now() + 1, now }) };
}

const api = (base: string, path: string) => fetch(new URL(path, base), { headers: { cookie: `factory_session=${TOKEN}` } });

describe("parsePort", () => {
  it("takes a port number and nothing else", () => {
    expect(parsePort("4181")).toBe(4181);
    for (const bad of ["0", "65536", "x", "1.5"]) expect(() => parsePort(bad)).toThrow(CliError);
  });
});

describe("runServe", () => {
  it("says to register a project when there is none", async () => {
    await expect(runServe({ port: 0 }, { projects: () => [] })).rejects.toThrow(new CliError("No projects registered. Run `factory init` in a repository first."));
  });

  it("serves the API on the printed link, shares one context with the scheduler, and drains on `factory stop`", async () => {
    const s = setup();
    const served = runServe({ port: 0, maxRuns: 2 }, s.deps);
    const url = await s.url;

    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/\\?token=${TOKEN}$`));
    expect(s.browser).toEqual([url]);
    expect(s.lines).toEqual([
      "[shop] finished run abc: its PR was merged",
      "Serving 1 project, up to 2 runs at once.",
      `Open ${url}`,
      "Stop with `factory stop` (finishes the runs going on) or `factory stop --now`; Ctrl+C interrupts.",
    ]);

    // The scheduler parks the run at triage; the routes see it through the same store.
    await vi.waitFor(async () => {
      const runs = (await (await api(url, "/api/runs?view=waiting")).json()) as { state: string; projectName: string }[];
      expect(runs).toMatchObject([{ state: "needs_human", projectName: "shop" }]);
    });
    expect(s.opened).toEqual(["/repos/shop"]);
    expect(await (await api(url, "/api/scheduler")).json()).toMatchObject({ running: [] });

    s.requestStop();
    expect(await served).toEqual({ message: "Stopped: no runs are going on.", interrupted: false });
    await expect(api(url, "/api/projects")).rejects.toThrow();
    expect(() => s.store.listRuns()).toThrow();
  });

  it("does not open the browser with --no-open, and Ctrl+C interrupts", async () => {
    const s = setup();
    const interrupt = new AbortController();
    const served = runServe({ port: 0, open: false }, { ...s.deps, signal: interrupt.signal });
    await s.url;

    interrupt.abort();

    expect(await served).toMatchObject({ interrupted: true });
    expect(s.browser).toEqual([]);
  });

  it("says when the port is taken", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(runServe({ port }, setup().deps)).rejects.toThrow(new CliError(`Port ${port} is in use. Pick another with --port.`));
    } finally {
      blocker.close();
    }
  });
});
