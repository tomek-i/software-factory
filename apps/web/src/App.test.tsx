// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, newQueryClient } from "./App";
import type { Backlog, ProjectInfo, RunRow } from "./lib/api";

const PROJECT: ProjectInfo = { key: "p1", name: "shop", path: "/repos/shop", status: "ok" };

function runRow(patch: Partial<RunRow> = {}): RunRow {
  return {
    project: "p1",
    projectName: "shop",
    id: "run-1",
    issue: 12,
    title: "Add the feature",
    state: "needs_human",
    waitingGate: "triage",
    build: 1,
    review: 1,
    cost: 0.42,
    held: false,
    updatedAt: new Date().toISOString(),
    reason: "triage waits for you",
    resumeTargets: [],
    ...patch,
  };
}

/** A stand-in for the server: answers by method and path, and records what was posted. */
class FakeServer {
  runs: RunRow[] = [];
  backlog: Backlog = { github: "acme/shop", syncedAt: null, issues: [] };
  posts: { path: string; body: unknown }[] = [];
  /** Answers to posts by path suffix, e.g. a refusal. */
  failures = new Map<string, { status: number; error: string }>();
  projectsStatus = 200;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://127.0.0.1:4180");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (init?.method === "POST") {
      this.posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      for (const [suffix, failure] of this.failures) if (url.pathname.endsWith(suffix)) return json(failure.status, { error: failure.error });
      if (url.pathname.endsWith("/sync")) return json(200, { open: 3, closed: 1, queued: 2, lines: [] });
      return json(200, {});
    }
    if (url.pathname === "/api/projects") return this.projectsStatus === 200 ? json(200, [PROJECT]) : json(this.projectsStatus, { error: "Open the link `factory serve` printed." });
    if (url.pathname === "/api/scheduler") return json(200, { running: [] });
    if (url.pathname === "/api/runs") {
      const view = url.searchParams.get("view");
      return json(200, this.runs.filter((r) => view !== "waiting" || r.state === "needs_human" || r.state === "needs_info"));
    }
    if (url.pathname === "/api/projects/p1/issues") return json(200, this.backlog);
    return json(404, { error: "Not found." });
  };
}

/** The page's one EventSource, which a test can push events through. */
class FakeEventSource {
  static last?: FakeEventSource;
  onopen?: () => void;
  onerror?: () => void;
  onmessage?: (message: MessageEvent<string>) => void;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  send(event: object) {
    act(() => this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>));
  }
  close() {
    this.closed = true;
  }
}

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderAt(path: string) {
  const client = newQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  render(
    <MemoryRouter initialEntries={[path]}>
      <App client={client} />
    </MemoryRouter>,
  );
}

describe("layout", () => {
  it("counts the runs waiting for you on the Inbox tab, and opens the event stream", async () => {
    server.runs = [runRow(), runRow({ id: "run-2", state: "needs_info", waitingGate: null }), runRow({ id: "run-3", state: "build", waitingGate: null })];
    renderAt("/runs");

    expect(await screen.findByLabelText("1 waiting")).toBeTruthy();
    expect(FakeEventSource.last?.url).toBe("/api/events");
  });

  it("asks for the printed link when there is no session", async () => {
    server.projectsStatus = 401;
    renderAt("/inbox");

    expect(await screen.findByText("No session")).toBeTruthy();
  });
});

describe("inbox", () => {
  it("approves a gate with an optional note", async () => {
    server.runs = [runRow()];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Approve/ }));
    await user.type(screen.getByLabelText("Note"), "looks right");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/approve", body: { message: "looks right" } }]));
  });

  it("rejects only with a reason, and shows the server's refusal", async () => {
    server.runs = [runRow()];
    server.failures.set("/reject", { status: 400, error: "Run run-1 is not waiting at a gate (it is build)." });
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Reject/ }));
    const submit = screen.getByRole("button", { name: "Reject" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Reason"), "not now");
    await user.click(submit);

    expect((await screen.findByRole("alert")).textContent).toBe("Run run-1 is not waiting at a gate (it is build).");
    expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/reject", body: { message: "not now" } }]);
  });

  it("resumes an escalation to a stage it picks, and lists runs waiting for their author", async () => {
    server.runs = [
      runRow({ waitingGate: null, reason: "the build agent failed", resumeTargets: ["build", "triage"] }),
      runRow({ id: "run-2", issue: 13, title: "Answer me", state: "needs_info", waitingGate: null }),
    ];
    renderAt("/inbox");
    const user = userEvent.setup();

    expect(await screen.findByText("escalation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(screen.getByText("Answer me")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Resume/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: /Send it to/ }), "triage");
    await user.type(screen.getByLabelText("Reason"), "try again");
    await user.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/resume", body: { to: "triage", message: "try again" } }]));
  });

  it("cancels a run without a reason", async () => {
    server.runs = [runRow()];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Cancel run/ }));
    await user.click(within(screen.getByRole("form", { name: "Cancel run" })).getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/cancel", body: {} }]));
  });
});

describe("backlog", () => {
  it("queues and unqueues issues, shows their place and trust, and syncs", async () => {
    server.backlog.issues = [
      { number: 5, title: "Queued one", author: "alice", url: "https://github.com/acme/shop/issues/5", labels: [], queued: true, position: 1, trusted: true, run: null },
      { number: 4, title: "From a stranger", author: "mallory", url: "https://github.com/acme/shop/issues/4", labels: [], queued: false, position: null, trusted: false, run: { id: "r", state: "done", waitingGate: null } },
    ];
    renderAt("/backlog");
    const user = userEvent.setup();

    const queued = (await screen.findByText("Queued one")).closest("tr")!;
    expect(within(queued).getByText("Q1")).toBeTruthy();
    const stranger = screen.getByText("From a stranger").closest("tr")!;
    expect(within(stranger).getByText("untrusted")).toBeTruthy();
    expect(within(stranger).getByText("done")).toBeTruthy();

    await user.click(within(queued).getByRole("button", { name: "Unqueue" }));
    await user.click(within(stranger).getByRole("button", { name: "Queue" }));
    await user.click(screen.getByRole("button", { name: /Sync now/ }));

    expect(await screen.findByText("Synced: 3 open, 1 closed since last sync, 2 queued.")).toBeTruthy();
    expect(server.posts.map((p) => p.path)).toEqual(["/api/projects/p1/issues/5/unqueue", "/api/projects/p1/issues/4/queue", "/api/projects/p1/sync"]);
  });
});

describe("runs", () => {
  it("shows a run's latest activity as it streams in", async () => {
    server.runs = [runRow({ state: "build", waitingGate: null, reason: "triage approved", held: true })];
    renderAt("/runs");

    expect(await screen.findByText("triage approved")).toBeTruthy();
    expect(screen.getByLabelText("working")).toBeTruthy();
    FakeEventSource.last!.send({ type: "run", project: "shop", issue: 12, event: { type: "agent:activity", runId: "run-1", agentRunId: "a", summary: "Editing feature.txt" } });

    expect(await screen.findByText("Editing feature.txt")).toBeTruthy();
    expect(screen.queryByText("triage approved")).toBeNull();
  });
});
