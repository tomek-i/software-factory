import { describe, expect, it } from "vitest";
import { Store } from "../store/store.js";
import type { CommandRunner } from "../util/exec.js";
import { fetchIssue, GithubError, syncIssues } from "./issues.js";

function ghIssue(number: number, extra: object = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: "body",
    state: "OPEN",
    author: { login: "alice" },
    labels: [{ name: "bug" }],
    url: `https://github.com/acme/shop/issues/${number}`,
    updatedAt: "2026-11-01T00:00:00Z",
    ...extra,
  };
}

function fakeGh(responses: { list?: object[]; view?: object; fail?: boolean }) {
  const calls: string[][] = [];
  const run: CommandRunner = (_cmd, args) => {
    calls.push(args);
    if (responses.fail) return { code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" };
    const body = args[1] === "list" ? responses.list : responses.view;
    return { code: 0, stdout: JSON.stringify(body), stderr: "" };
  };
  return { run, calls };
}

function setup() {
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "shop", repo_path: "/repo", github_repo: "acme/shop" });
  return { store, project };
}

describe("syncIssues", () => {
  it("stores open issues with labels for display", () => {
    const { store, project } = setup();
    const gh = fakeGh({ list: [ghIssue(1), ghIssue(2, { author: null, body: null })] });

    expect(syncIssues(store, project, gh.run)).toEqual({ open: 2, closed: 0 });
    expect(gh.calls[0]).toEqual(expect.arrayContaining(["-R", "acme/shop", "--state", "open"]));
    expect(store.getIssue(project.id, 1)).toMatchObject({ state: "open", labels: ["bug"], author: "alice", queued_at: null });
    expect(store.getIssue(project.id, 2)).toMatchObject({ author: "ghost", body: "" });
  });

  it("never queues an issue because of its labels", () => {
    const { store, project } = setup();
    syncIssues(store, project, fakeGh({ list: [ghIssue(1, { labels: [{ name: "factory" }] })] }).run);
    expect(store.listIssues({ project_id: project.id, queued: true })).toEqual([]);
  });

  it("keeps the local queue decision across syncs", () => {
    const { store, project } = setup();
    syncIssues(store, project, fakeGh({ list: [ghIssue(1)] }).run);
    store.setQueued(project.id, 1, true);

    syncIssues(store, project, fakeGh({ list: [ghIssue(1, { title: "renamed" })] }).run);

    expect(store.getIssue(project.id, 1)).toMatchObject({ title: "renamed", queued_at: expect.any(String) });
  });

  it("closes and unqueues issues that are no longer open", () => {
    const { store, project } = setup();
    syncIssues(store, project, fakeGh({ list: [ghIssue(1), ghIssue(2)] }).run);
    store.setQueued(project.id, 2, true);

    expect(syncIssues(store, project, fakeGh({ list: [ghIssue(1)] }).run)).toEqual({ open: 1, closed: 1 });
    expect(store.getIssue(project.id, 2)).toMatchObject({ state: "closed", queued_at: null });
  });

  it("changes nothing when gh fails", () => {
    const { store, project } = setup();
    syncIssues(store, project, fakeGh({ list: [ghIssue(1)] }).run);

    expect(() => syncIssues(store, project, fakeGh({ fail: true }).run)).toThrow(/Bad credentials/);
    expect(store.getIssue(project.id, 1)!.state).toBe("open");
  });

  it("refuses a truncated list rather than closing issues past the limit", () => {
    const { store, project } = setup();
    expect(() => syncIssues(store, project, fakeGh({ list: [ghIssue(1), ghIssue(2)] }).run, 2)).toThrow(GithubError);
  });

  it("needs a GitHub repository", () => {
    const store = new Store(":memory:");
    const project = store.upsertProject({ name: "local", repo_path: "/local" });
    expect(() => syncIssues(store, project, fakeGh({ list: [] }).run)).toThrow(/no GitHub repository/);
  });
});

describe("syncIssues races", () => {
  it("does not close an issue queued while the sync's GitHub request was in flight", () => {
    const { store, project } = setup();
    let listed = false;
    const run: CommandRunner = (_cmd, args) => {
      if (args[1] === "list" && !listed) {
        listed = true;
        // While `gh issue list` runs, the user queues brand-new issue #20 from another terminal.
        const later = Date.now() + 5;
        while (Date.now() < later) {
          // wait so the fetch is strictly after the sync started
        }
        fetchIssue(store, project, 20, fakeGh({ view: ghIssue(20) }).run);
        store.setQueued(project.id, 20, true);
        return { code: 0, stdout: JSON.stringify([ghIssue(1)]), stderr: "" };
      }
      return { code: 0, stdout: "[]", stderr: "" };
    };

    syncIssues(store, project, run);

    expect(store.getIssue(project.id, 20)).toMatchObject({ state: "open", queued_at: expect.any(String) });
  });
});

describe("fetchIssue", () => {
  it("stores a single issue, including closed ones", () => {
    const { store, project } = setup();
    fetchIssue(store, project, 7, fakeGh({ view: ghIssue(7, { state: "CLOSED" }) }).run);
    expect(store.getIssue(project.id, 7)!.state).toBe("closed");
  });

  it("refuses pull requests, which gh issue view also returns", () => {
    const { store, project } = setup();
    const pr = ghIssue(8, { url: "https://github.com/acme/shop/pull/8" });
    expect(() => fetchIssue(store, project, 8, fakeGh({ view: pr }).run)).toThrow(/pull request/);
    expect(store.getIssue(project.id, 8)).toBeUndefined();
  });

  it("refuses an issue that resolved to a different number", () => {
    const { store, project } = setup();
    expect(() => fetchIssue(store, project, 8, fakeGh({ view: ghIssue(9) }).run)).toThrow(/resolved to #9/);
  });

  it("turns unexpected gh output into a GithubError", () => {
    const { store, project } = setup();
    const run: CommandRunner = () => ({ code: 0, stdout: "", stderr: "" });
    expect(() => fetchIssue(store, project, 1, run)).toThrow(GithubError);
  });
});

describe("Store.setQueued", () => {
  it("refuses unknown and closed issues", () => {
    const { store, project } = setup();
    expect(() => store.setQueued(project.id, 9, true)).toThrow(/not synced/);
    fetchIssue(store, project, 7, fakeGh({ view: ghIssue(7, { state: "CLOSED" }) }).run);
    expect(() => store.setQueued(project.id, 7, true)).toThrow(/closed/);
  });

  it("lists queued issues in the order they were queued, even within one millisecond", () => {
    const { store, project } = setup();
    syncIssues(store, project, fakeGh({ list: [ghIssue(12), ghIssue(15), ghIssue(18)] }).run);
    for (const n of [18, 12, 15]) store.setQueued(project.id, n, true);

    expect(store.listIssues({ project_id: project.id, queued: true }).map((i) => i.number)).toEqual([18, 12, 15]);
    store.setQueued(project.id, 12, false);
    expect(store.listIssues({ project_id: project.id, queued: true }).map((i) => i.number)).toEqual([18, 15]);
    store.setQueued(project.id, 12, true);
    expect(store.listIssues({ project_id: project.id, queued: true }).map((i) => i.number)).toEqual([18, 15, 12]);
  });
});
