// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, newQueryClient } from "./App";
import type { Backlog, ProjectInfo, RunDetail, RunRow } from "./lib/api";

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
  /** Run files by path, served for every run. */
  files: Record<string, string> = {};
  /** The detail of a run is built from its row in runs. */
  detail = (run: RunRow): RunDetail => ({
    run,
    issue: run.issue === null ? null : { number: run.issue, title: `Issue ${run.issue}`, url: `https://github.com/acme/shop/issues/${run.issue}` },
    hasRunDir: true,
    files: Object.keys(this.files),
    sections: [
      { kind: "verdict", path: "triage.md", key: "DECISION", value: "APPROVE", summary: ["risk is HIGH: it touches auth"], blocking: [], refuted: 0 },
      { kind: "verdict", path: "spec-1/critic.md", key: "VERDICT", value: "ACCEPT", summary: ["the spec holds"], blocking: [], refuted: 0 },
      {
        kind: "verdict",
        path: "round-1/review-security.md",
        key: "VERDICT",
        value: "CHANGES_REQUESTED",
        summary: [],
        blocking: [{ id: "S1", severity: "major", file: "src/auth.ts", line: 4, claim: "the token is logged", evidence: "line 4" }],
        refuted: 1,
      },
      { kind: "unparsed", path: "build.md", problem: "STATUS is missing" },
    ],
  });
  /** The token each request carried. */
  tokens = new Set<string | null>();
  private stream?: ReadableStreamDefaultController<string>;

  /** Pushes an event down the page's event stream. */
  send(event: object) {
    act(() => this.stream?.enqueue(`id: 1
data: ${JSON.stringify(event)}

`));
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://127.0.0.1:4180");
    this.tokens.add(new Headers(init?.headers).get("x-factory-token"));
    if (url.pathname === "/api/events") {
      const body = new ReadableStream<string>({ start: (controller) => void (this.stream = controller) }).pipeThrough(new TextEncoderStream());
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
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
    const file = /^\/api\/projects\/p1\/runs\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
    if (file) {
      const path = file[2]!.split("/").map(decodeURIComponent).join("/");
      return path in this.files ? json(200, { path, text: this.files[path] }) : json(400, { error: `No file "${path}".` });
    }
    const detail = /^\/api\/projects\/p1\/runs\/([^/]+)$/.exec(url.pathname);
    const run = detail && this.runs.find((r) => r.id === decodeURIComponent(detail[1]!));
    if (run) return json(200, this.detail(run));
    return json(404, { error: "Not found." });
  };
}

let server: FakeServer;

beforeEach(() => {
  server = new FakeServer();
  vi.stubGlobal("fetch", server.fetch);
  localStorage.setItem("factory.token", "t".repeat(64));
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
  it("counts the runs waiting for you on the Inbox tab, sending the session token", async () => {
    server.runs = [runRow(), runRow({ id: "run-2", state: "needs_info", waitingGate: null }), runRow({ id: "run-3", state: "build", waitingGate: null })];
    renderAt("/runs");

    expect(await screen.findByLabelText("1 waiting")).toBeTruthy();
    expect([...server.tokens]).toEqual(["t".repeat(64)]);
  });

  it("lines the header row and the page content up in one column that widens only on large screens", async () => {
    renderAt("/runs");

    await screen.findByLabelText("Project");
    const classes = (el: Element) => new Set(el.className.split(/\s+/));
    const header = classes(screen.getByRole("banner").firstElementChild!);
    const main = classes(screen.getByRole("main"));
    for (const c of ["mx-auto", "max-w-6xl", "px-4", "xl:px-6", "2xl:max-w-(--breakpoint-2xl)", "2xl:px-8", "min-[120rem]:max-w-[1800px]"]) {
      expect(header.has(c), `header has ${c}`).toBe(true);
      expect(main.has(c), `main has ${c}`).toBe(true);
    }
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

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/approve", body: { state: "needs_human", gate: "triage", message: "looks right" } }]));
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
    expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/reject", body: { state: "needs_human", gate: "triage", message: "not now" } }]);
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

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/resume", body: { state: "needs_human", to: "triage", message: "try again" } }]));
  });

  it("cancels a run without a reason", async () => {
    server.runs = [runRow()];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Cancel run/ }));
    await user.click(within(screen.getByRole("form", { name: "Cancel run" })).getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/cancel", body: { state: "needs_human", gate: "triage" } }]));
  });
});

describe("run details", () => {
  it("opens from an Inbox card with the gate, the full reason and the run's verdicts, and approves from there", async () => {
    server.runs = [runRow({ reason: "triage rated the risk HIGH: the change touches the login flow and the session store" })];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: /Add the feature/ }));

    expect(await screen.findByRole("heading", { name: /#12\s*Issue 12/ })).toBeTruthy();
    expect(screen.getByText("triage gate")).toBeTruthy();
    expect(screen.getByText("triage rated the risk HIGH: the change touches the login flow and the session store")).toBeTruthy();
    expect(screen.getByText("DECISION: APPROVE")).toBeTruthy();
    expect(screen.getByText("risk is HIGH: it touches auth")).toBeTruthy();
    expect(screen.getByText("VERDICT: ACCEPT")).toBeTruthy();
    expect(screen.getByText("the token is logged")).toBeTruthy();
    expect(screen.getByText("1 refuted by the verifier")).toBeTruthy();
    expect(screen.getByText("STATUS is missing")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Issue on GitHub/ }).getAttribute("href")).toBe("https://github.com/acme/shop/issues/12");

    await user.click(screen.getByRole("button", { name: /Approve/ }));
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/approve", body: { state: "needs_human", gate: "triage" } }]));
  });

  it("rejects, resumes and cancels from the detail view with the card's rules", async () => {
    server.runs = [runRow(), runRow({ id: "run-2", waitingGate: null, reason: "the build agent failed", resumeTargets: ["build", "triage"] })];
    renderAt("/runs/p1/run-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Reject/ }));
    const reject = screen.getByRole("button", { name: "Reject" });
    expect((reject as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Reason"), "too risky");
    await user.click(reject);
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/reject", body: { state: "needs_human", gate: "triage", message: "too risky" } }]));

    cleanup();
    server.posts = [];
    renderAt("/runs/p1/run-2");
    expect(await screen.findByText("escalation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Resume/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: /Send it to/ }), "triage");
    await user.type(screen.getByLabelText("Reason"), "try again");
    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-2/resume", body: { state: "needs_human", to: "triage", message: "try again" } }]));

    await user.click(screen.getByRole("button", { name: /Cancel run/ }));
    await user.click(within(screen.getByRole("form", { name: "Cancel run" })).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(server.posts.at(-1)).toEqual({ path: "/api/projects/p1/runs/run-2/cancel", body: { state: "needs_human" } }));
  });

  it("opens from a run row, read-only for a run that isn't waiting, and shows a file's script tag as text", async () => {
    server.runs = [runRow({ state: "build", waitingGate: null, reason: "triage approved" })];
    server.files = { "triage.md": "DECISION: APPROVE\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>", "round-1/checks.md": "GATE: PASS" };
    renderAt("/runs");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: /Add the feature/ }));

    expect(await screen.findByRole("heading", { name: /#12\s*Issue 12/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve|Reject|Resume|Cancel run/ })).toBeNull();
    await user.click(within(screen.getByRole("list", { name: "Run files" })).getByRole("button", { name: "triage.md" }));

    const contents = await screen.findByLabelText("Contents of triage.md");
    expect(contents.textContent).toBe("DECISION: APPROVE\n<script>alert(1)</script>\n<img src=x onerror=alert(2)>");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();

    await user.click(screen.getByRole("button", { name: "round-1/checks.md" }));
    expect((await screen.findByLabelText("Contents of round-1/checks.md")).textContent).toBe("GATE: PASS");
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
    await waitFor(() => expect(screen.getByTitle("Live")).toBeTruthy());
    server.send({ type: "run", project: "shop", issue: 12, event: { type: "agent:activity", runId: "run-1", agentRunId: "a", summary: "Editing feature.txt" } });

    expect(await screen.findByText("Editing feature.txt")).toBeTruthy();
    expect(screen.queryByText("triage approved")).toBeNull();
  });
});
