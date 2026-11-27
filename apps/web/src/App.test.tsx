// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, newQueryClient } from "./App";
import type { AuditDetail, AuditList, Backlog, BacklogIssue, DraftDetail, DraftView, MergeGateDetails, ProjectInfo, ProjectSettings, RunChecks, RunDetail, RunRow, SchedulerStatus } from "./lib/api";
import { BacklogTable } from "./screens/Backlog";

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
    pr: null,
    build: 1,
    review: 1,
    resyncs: 0,
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
  /** The paths of every GET, in order. */
  gets: string[] = [];
  /** Answers to posts by path suffix, e.g. a refusal. */
  failures = new Map<string, { status: number; error: string }>();
  /** Successful answers to posts by path suffix; others get {}. */
  answers = new Map<string, unknown>();
  /** Pending drafts, and each draft's page by id. */
  drafts: DraftView[] = [];
  draftDetails: Record<string, DraftDetail> = {};
  projectsStatus = 200;
  /** The project list. */
  projects: ProjectInfo[] = [PROJECT];
  /** Merge-gate details by run id; others get a 404. */
  mergeGate: Record<string, MergeGateDetails> = {};
  /** Run files by path, served for every run. */
  files: Record<string, string> = {};
  /** What `factory serve`'s scheduler is doing. */
  scheduler: SchedulerStatus = { running: [] };
  /** The failed checks of each run's PR, by run id. */
  checks: Record<string, RunChecks> = {};
  /** The detail of a run is built from its row in runs. */
  detail = (run: RunRow): RunDetail => ({
    run,
    issue: run.issue === null ? null : { number: run.issue, title: `Issue ${run.issue}`, url: `https://github.com/acme/shop/issues/${run.issue}` },
    hasRunDir: true,
    files: Object.keys(this.files),
    unshown: {},
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
  /** The settings page of project p1. */
  settings?: ProjectSettings;
  /** Project p1's audits, and each audit's page by id. */
  audits: AuditList = { schedule: "off", github: "acme/shop", audits: [] };
  auditDetails: Record<string, AuditDetail> = {};
  /** Filing a finding is refused as on a public repository unless the page says public: true. */
  publicRepo = false;
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
    const changes = init?.method === "POST" || init?.method === "PUT";
    if (!changes) this.gets.push(url.pathname);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (changes) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.posts.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/file") && this.publicRepo && body.public !== true) return json(409, { error: "acme/shop is public", code: "public_repo" });
      for (const [suffix, failure] of this.failures) if (url.pathname.endsWith(suffix)) return json(failure.status, { error: failure.error });
      if (url.pathname.endsWith("/sync")) return json(200, { open: 3, closed: 1, queued: 2, lines: [] });
      for (const [suffix, answer] of this.answers) if (url.pathname.endsWith(suffix)) return json(200, answer);
      return json(200, {});
    }
    if (url.pathname === "/api/projects") return this.projectsStatus === 200 ? json(200, this.projects) : json(this.projectsStatus, { error: "Open the link `factory serve` printed." });
    if (url.pathname === "/api/scheduler") return json(200, this.scheduler);
    if (url.pathname === "/api/runs") {
      const view = url.searchParams.get("view");
      return json(200, this.runs.filter((r) => view !== "waiting" || r.state === "needs_human" || r.state === "needs_info"));
    }
    if (url.pathname === "/api/projects/p1/issues") return json(200, this.backlog);
    if (url.pathname === "/api/projects/p1/settings") return this.settings ? json(200, this.settings) : json(404, { error: "Not found." });
    if (url.pathname === "/api/drafts") return json(200, this.drafts);
    if (url.pathname === "/api/projects/p1/audits") return json(200, this.audits);
    const audit = /^\/api\/projects\/p1\/audits\/([^/]+)$/.exec(url.pathname);
    if (audit) {
      const found = this.auditDetails[decodeURIComponent(audit[1]!)];
      return found ? json(200, found) : json(400, { error: "No audit." });
    }
    const draft = /^\/api\/projects\/p1\/drafts\/([^/]+)$/.exec(url.pathname);
    if (draft) {
      const found = this.draftDetails[decodeURIComponent(draft[1]!)];
      return found ? json(200, found) : json(404, { error: "No draft." });
    }
    const file = /^\/api\/projects\/p1\/runs\/([^/]+)\/files\/(.+)$/.exec(url.pathname);
    if (file) {
      const path = file[2]!.split("/").map(decodeURIComponent).join("/");
      return path in this.files ? json(200, { path, text: this.files[path] }) : json(400, { error: `No file "${path}".` });
    }
    const merge = /^\/api\/projects\/p1\/runs\/([^/]+)\/merge-gate$/.exec(url.pathname);
    if (merge) {
      const found = this.mergeGate[decodeURIComponent(merge[1]!)];
      return found ? json(200, found) : json(404, { error: "Not at the merge gate." });
    }
    const checks = /^\/api\/projects\/p1\/runs\/([^/]+)\/checks$/.exec(url.pathname);
    if (checks) {
      const found = this.checks[decodeURIComponent(checks[1]!)];
      return found ? json(200, found) : json(502, { error: "GitHub: gh api failed" });
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

/** Hands the router's navigate to a test, to change the URL while a screen stays mounted. */
function Navigator({ onReady }: { onReady: (navigate: NavigateFunction) => void }) {
  onReady(useNavigate());
  return null;
}

function renderAt(path: string) {
  const client = newQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  let go: NavigateFunction | undefined;
  render(
    <MemoryRouter initialEntries={[path]}>
      <Navigator onReady={(n) => (go = n)} />
      <App client={client} />
    </MemoryRouter>,
  );
  return { navigate: (to: string) => act(() => void go!(to)) };
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

  it("warns on every screen while the start limit holds a queue back, with when it lifts", async () => {
    const at = new Date(new Date().setHours(13, 53, 0, 0));
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    server.scheduler = { running: [], limited: [{ project: "shop", started: 10, max: 10, until: at.toISOString() }] };
    renderAt("/runs");

    const note = await screen.findByLabelText(/^Start limit/);
    expect(note.textContent).toBe(`start limit until ${time}`);
    expect(note.getAttribute("aria-label")).toBe(`Start limit reached for shop: the next queued issue can start at ${time}.`);
  });

  it("says no time when a limit of 0 holds a queue back, and nothing without a limit", async () => {
    server.scheduler = { running: [], limited: [{ project: "shop", started: 0, max: 0 }] };
    renderAt("/runs");
    expect((await screen.findByLabelText(/^Start limit/)).textContent).toBe("start limit: none start");

    cleanup();
    server.scheduler = { running: [] };
    renderAt("/runs");
    await screen.findByText("0 running");
    expect(screen.queryByLabelText(/^Start limit/)).toBeNull();
  });
});

describe("inbox", () => {
  it("says which projects the start limit holds back and when each can start again, for the project picked", async () => {
    const at = new Date(new Date().setHours(13, 53, 0, 0));
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    server.projects = [PROJECT, { key: "p2", name: "cafe", path: "/repos/cafe", status: "ok" }];
    server.scheduler = {
      running: [],
      limited: [
        { project: "shop", started: 10, max: 10, until: at.toISOString() },
        { project: "cafe", started: 0, max: 0 },
      ],
    };
    renderAt("/inbox");
    const user = userEvent.setup();

    const notes = await screen.findByRole("list", { name: "Start limits" });
    expect(within(notes).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      `shop: Start limit reached: 10 runs started in the last 24 h (github.max_starts_per_day). The next queued issue can start at ${time}.`,
      "cafe: Start limit: github.max_starts_per_day is 0, so no queued issue starts until it is raised.",
    ]);

    await user.selectOptions(screen.getByLabelText("Project"), "p2");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Start limits" })).getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("list", { name: "Start limits" }).textContent).toMatch(/^cafe: /);
  });

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

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/resume", body: { state: "needs_human", to: "triage", message: "try again", resetLoops: false } }]));
  });

  it("sends a run at a gate back to an earlier stage, explaining each target, with the loops reset when a cap stopped it", async () => {
    server.runs = [
      runRow({
        waitingGate: "review",
        reason: "waiting at review gate: review round cap reached (3)",
        resumeTargets: ["refine", "build"],
        capReached: "review round cap reached (3)",
      }),
    ];
    renderAt("/inbox");
    const user = userEvent.setup();

    expect(await screen.findByRole("button", { name: /Approve/ })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Send back to/ }));
    const select = screen.getByRole("combobox", { name: /Send it to/ }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["refine", "build"]);
    expect(select.value).toBe("build");
    expect(screen.getByText("build: the builder gets your message, then checks and reviews run again")).toBeTruthy();
    const reset = screen.getByRole("checkbox", { name: /Reset loop counters/ }) as HTMLInputElement;
    expect(reset.checked).toBe(true);
    expect(screen.getByText("It stopped because the review round cap reached (3): without fresh counters it stops again at once.")).toBeTruthy();
    await user.selectOptions(select, "refine");
    expect(screen.getByText(/^refine: refine gets your message/)).toBeTruthy();
    const send = screen.getByRole("button", { name: "Send back" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await user.type(screen.getByLabelText("Reason"), "split the spec");
    await user.click(send);

    await waitFor(() =>
      expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/resume", body: { state: "needs_human", gate: "review", to: "refine", message: "split the spec", resetLoops: true } }]),
    );
  });

  it("offers no way back at a gate with no earlier working stage, and warns before starting over", async () => {
    server.runs = [runRow(), runRow({ id: "run-2", issue: 13, waitingGate: null, reason: "the build agent failed", resumeTargets: ["intake", "triage", "build"] })];
    server.failures.set("/resume", { status: 400, error: "Run run-2 can resume to: intake, build." });
    renderAt("/inbox");
    const user = userEvent.setup();

    await screen.findAllByRole("button", { name: /Cancel run/ });
    expect(screen.queryByRole("button", { name: /Send back to/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Resume/ }));
    expect(screen.queryByRole("note")).toBeNull();
    expect((screen.getByRole("checkbox", { name: /Reset loop counters/ }) as HTMLInputElement).checked).toBe(false);
    await user.selectOptions(screen.getByRole("combobox", { name: /Send it to/ }), "intake");
    expect(screen.getByText("intake: starts over: triage, the spec and the build run again")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toMatch(/Costs more: triage, the spec critic and the build all run again/);
    await user.type(screen.getByLabelText("Reason"), "start over");
    await user.click(screen.getByRole("button", { name: "Resume" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Run run-2 can resume to: intake, build.");
  });

  it("sends the failure the run waits on to the builder, prefilled and editable", async () => {
    server.runs = [
      runRow({
        waitingGate: null,
        reason: "quality gate still failing after round 2: build iteration cap reached (5)",
        resumeTargets: ["intake", "triage", "build", "gate"],
        failure: { kind: "quality_gate", source: "round-2/checks.md", items: [{ name: "test", summary: "FAILED (exit 1) in 2.0s" }] },
      }),
    ];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Send to builder with this failure/ }));

    expect((screen.getByRole("combobox", { name: /Send it to/ }) as HTMLSelectElement).value).toBe("build");
    expect((screen.getByRole("checkbox", { name: /Reset loop counters/ }) as HTMLInputElement).checked).toBe(true);
    const reason = screen.getByLabelText("Reason") as HTMLTextAreaElement;
    expect(reason.value).toBe("Fix what failed the quality gate (see round-2/checks.md in the run folder):\n- test: FAILED (exit 1) in 2.0s");
    await user.type(reason, "\nThe fixture is flaky.");
    await user.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(server.posts).toEqual([
        {
          path: "/api/projects/p1/runs/run-1/resume",
          body: {
            state: "needs_human",
            to: "build",
            message: "Fix what failed the quality gate (see round-2/checks.md in the run folder):\n- test: FAILED (exit 1) in 2.0s\nThe fixture is flaky.",
            resetLoops: true,
          },
        },
      ]),
    );
  });

  it("lists the open review threads and checks at the merge gate with their links, and merges anyway or sends them to the builder", async () => {
    server.runs = [
      runRow({
        waitingGate: "merge",
        reason: "waiting at merge gate: unresolved review thread by bob at src/a.ts:3 (https://github.com/acme/shop/pull/7#discussion_r1)",
        resumeTargets: ["refine", "build", "review"],
        failure: {
          kind: "feedback",
          source: "round-1/resync/feedback.md",
          items: [
            { name: "review thread by bob", summary: "rename this", file: "src/a.ts", line: 3, link: "https://github.com/acme/shop/pull/7#discussion_r1" },
            { name: "CodeQL", summary: "failed: 2 new alerts", link: "javascript:alert(1)" },
          ],
        },
      }),
    ];
    renderAt("/inbox");
    const user = userEvent.setup();

    const list = await screen.findByRole("list", { name: "Open on the pull request" });
    expect(within(list).getByRole("link", { name: "review thread by bob" }).getAttribute("href")).toBe("https://github.com/acme/shop/pull/7#discussion_r1");
    expect(within(list).getByText(": rename this")).toBeTruthy();
    // A link GitHub or anyone else wrote is only followed when it is a web link.
    expect(within(list).queryByRole("link", { name: "CodeQL" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Send to builder with this failure/ }));
    expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe(
      "Deal with the open review threads and failed checks on the pull request (see round-1/resync/feedback.md in the run folder):\n- review thread by bob: rename this at src/a.ts:3 (https://github.com/acme/shop/pull/7#discussion_r1)\n- CodeQL: failed: 2 new alerts (javascript:alert(1))",
    );
    await user.click(screen.getByRole("button", { name: "Back" }));

    await user.click(screen.getByRole("button", { name: /Merge anyway/ }));
    await user.click(screen.getByRole("button", { name: "Merge anyway" }));
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/approve", body: { state: "needs_human", gate: "merge" } }]));
  });

  it("prefills confirmed findings with their file and line", async () => {
    server.runs = [
      runRow({
        waitingGate: "review",
        resumeTargets: ["refine", "build"],
        failure: { kind: "findings", source: "round-3/verify.md", items: [{ name: "code-1 (major)", summary: "the limiter is skipped", file: "src/a.ts", line: 12 }] },
      }),
    ];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Send to builder with this failure/ }));

    expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe(
      "Fix the findings the verifier confirmed (see round-3/verify.md in the run folder):\n- code-1 (major): the limiter is skipped at src/a.ts:12",
    );
    expect(screen.getByRole("button", { name: "Send back" })).toBeTruthy();
  });

  it("lists a failed code scanning check's alerts, dismisses one with a reason and a comment, and sends the rest to the builder", async () => {
    const alert = { number: 26, rule: "js/missing-rate-limiting", description: "Missing rate limiting", severity: "high", tool: "CodeQL", file: "src/drafts.ts", line: 296, url: "https://github.com/acme/shop/security/code-scanning/26" };
    server.runs = [
      runRow({
        waitingGate: null,
        reason: "required checks failed on PR #7: CodeQL; test",
        resumeTargets: ["build", "merge"],
        failure: { kind: "checks", items: [{ name: "CodeQL", link: "https://github.com/acme/shop/runs/1" }, { name: "test", link: "javascript:alert(1)" }] },
      }),
    ];
    server.checks = { "run-1": { pr: 7, failed: [{ name: "CodeQL", alerts: [alert] }, { name: "test", link: "javascript:alert(1)", alerts: [] }], otherAlerts: [] } };
    server.answers.set("/dismiss", { check: "CodeQL", failing: ["CodeQL", "test"], continued: false });
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Failed checks/ }));
    const panel = await screen.findByRole("region", { name: "Failed checks" });
    expect(await within(panel).findByText("Missing rate limiting")).toBeTruthy();
    expect(within(panel).getByText("src/drafts.ts:296")).toBeTruthy();
    expect(within(panel).getByRole("link", { name: "Alert on GitHub" }).getAttribute("href")).toBe(alert.url);
    expect(within(panel).getByText(/A required check can't be accepted here/)).toBeTruthy();
    // Only the code scanning check can be dismissed; the other's script link stays text.
    expect(within(panel).getAllByRole("button", { name: "Dismiss…" })).toHaveLength(1);
    expect(within(panel).queryByRole("link", { name: "test" })).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Dismiss…" }));
    const form = screen.getByRole("form", { name: "Dismiss alert #26" });
    const submit = within(form).getByRole("button", { name: "Dismiss alert" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.selectOptions(within(form).getByRole("combobox", { name: /Reason/ }), "used in tests");
    await user.type(within(form).getByLabelText("Comment"), "only the test server calls it");
    await user.click(submit);

    await waitFor(() =>
      expect(server.posts).toEqual([
        { path: "/api/projects/p1/runs/run-1/dismiss", body: { state: "needs_human", alert: 26, reason: "used in tests", comment: "only the test server calls it" } },
      ]),
    );
    expect((await screen.findByRole("status")).textContent).toBe("Dismissed alert #26. Still failing: CodeQL, test. The run keeps waiting.");

    await user.click(within(panel).getByRole("button", { name: /Send to builder with this failure/ }));
    expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe(
      "Fix the required checks that failed on the pull request:\n" +
        "- CodeQL: Missing rate limiting (js/missing-rate-limiting) at src/drafts.ts:296 (https://github.com/acme/shop/security/code-scanning/26)\n" +
        "- test (javascript:alert(1))",
    );
  });

  it("prefills a failed check with its name and link when GitHub can't list the alerts", async () => {
    server.runs = [
      runRow({ id: "run-9", waitingGate: null, resumeTargets: ["build"], failure: { kind: "checks", items: [{ name: "CodeQL", link: "https://github.com/acme/shop/runs/1" }] } }),
    ];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Send to builder with this failure/ }));

    expect(((await screen.findByLabelText("Reason")) as HTMLTextAreaElement).value).toBe(
      "Fix the required checks that failed on the pull request:\n- CodeQL (https://github.com/acme/shop/runs/1)",
    );
  });

  it("cancels a run without a reason", async () => {
    server.runs = [runRow()];
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Cancel run/ }));
    await user.click(within(screen.getByRole("form", { name: "Cancel run" })).getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/cancel", body: { state: "needs_human", gate: "triage" } }]));
  });

  it("says a run's issue was closed on GitHub and that cancelling closes its PR, and keeps the card when GitHub refuses", async () => {
    server.runs = [runRow({ waitingGate: "merge", issueClosed: { pr: 7 } })];
    const refusal = "Run run-1 was not cancelled: closing PR #7 failed: gh pr close failed: no access";
    server.failures.set("/cancel", { status: 400, error: refusal });
    renderAt("/inbox");
    const user = userEvent.setup();

    const note = "Issue #12 was closed on GitHub, so this work may be done elsewhere. Cancelling the run also closes PR #7 and deletes its branch.";
    expect((await screen.findByRole("note")).textContent).toBe(note);
    await user.click(screen.getByRole("button", { name: /Cancel run/ }));
    const form = screen.getByRole("form", { name: "Cancel run" });
    expect(within(form).getByRole("note").textContent).toBe(note);
    await user.click(within(form).getByRole("button", { name: "Cancel run" }));

    expect((await screen.findByRole("alert")).textContent).toBe(refusal);
  });

  it("shows no closed-issue note for a run whose issue is open", async () => {
    server.runs = [runRow()];
    renderAt("/inbox");
    expect(await screen.findByRole("button", { name: /Cancel run/ })).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("merge gate card", () => {
  const atMerge = (patch: Partial<RunRow> = {}) =>
    runRow({ waitingGate: "merge", pr: 7, build: 2, review: 3, cost: 1.5, reason: "waiting at merge gate: gate is set to human", ...patch });
  const details = (patch: Partial<MergeGateDetails> = {}): MergeGateDetails => ({
    pr: { number: 7, url: "https://github.com/acme/shop/pull/7", head: "abc", additions: 120, deletions: 40, changedFiles: 8 },
    checks: { passed: 5, failed: 0, pending: 1, skipped: 0, failedChecks: [] },
    reviews: [
      { lens: "code", path: "round-3/review-code.md", verdict: "PASS", findings: 2, blocking: 0 },
      { lens: "security", path: "round-3/review-security.md", verdict: "PASS", findings: 1, blocking: 0 },
      { lens: "docs", path: "round-3/review-docs.md", verdict: "PASS", findings: 0, blocking: 0 },
    ],
    rounds: { build: 2, review: 3 },
    cost: 1.5,
    ...patch,
  });

  it("shows the PR and its size, the checks, the reviews, rounds and cost, without the reason that repeats the gate", async () => {
    server.runs = [atMerge()];
    server.mergeGate["run-1"] = details();
    renderAt("/inbox");
    const user = userEvent.setup();

    const merge = await screen.findByLabelText("Merge details");
    expect(within(merge).getByRole("link", { name: "PR #7" }).getAttribute("href")).toBe("https://github.com/acme/shop/pull/7");
    expect(merge.textContent).toContain("+120 / -40, 8 files");
    expect(merge.textContent).toContain("5 passed, 0 failed, 1 pending");
    expect(merge.textContent).toContain("code PASS, security PASS, docs PASS · 3 review notes");
    expect(merge.textContent).toContain("build round 2 · review round 3 · $1.50");
    expect(screen.queryByText(/gate is set to human/)).toBeNull();
    expect(screen.queryByLabelText("Failed checks")).toBeNull();
    expect(screen.getByRole("link", { name: /Add the feature/ }).getAttribute("href")).toBe("/runs/p1/run-1");

    // No failed check: Approve as on any gate.
    await user.click(screen.getByRole("button", { name: /^Approve$/ }));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/approve", body: { state: "needs_human", gate: "merge" } }]));
  });

  it("warns on Approve when a check failed, lists the failures above it, links only web addresses, and still approves", async () => {
    server.runs = [atMerge({ reason: "waiting at merge gate: hard rule: touches .github/workflows/ci.yml" })];
    server.mergeGate["run-1"] = details({
      checks: {
        passed: 4,
        failed: 2,
        pending: 0,
        skipped: 1,
        failedChecks: [{ name: "CodeQL", link: "https://github.com/acme/shop/runs/9" }, { name: "evil", link: "javascript:alert(1)" }],
      },
    });
    renderAt("/inbox");
    const user = userEvent.setup();

    const failed = await screen.findByLabelText("Failed checks");
    expect(failed.textContent).toContain("2 checks failed on this PR");
    expect(within(failed).getByRole("link", { name: "CodeQL" }).getAttribute("href")).toBe("https://github.com/acme/shop/runs/9");
    expect(within(failed).getByText("evil").closest("a")).toBeNull();
    expect(screen.getByLabelText("Merge details").textContent).toContain("4 passed, 2 failed, 0 pending, 1 skipped");
    // A reason that says more than the gate stays.
    expect(screen.getByText("waiting at merge gate: hard rule: touches .github/workflows/ci.yml")).toBeTruthy();
    // The failures come before the actions.
    const anyway = screen.getByRole("button", { name: /Approve anyway/ });
    expect(failed.compareDocumentPosition(anyway) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Readable in both themes (WCAG AA for small text): white only on amber-700 or darker, black on amber-500.
    const readable = (button: HTMLElement) => {
      const classes = new Set(button.className.split(/\s+/));
      for (const c of ["bg-amber-700", "text-white", "hover:bg-amber-800", "dark:bg-amber-500", "dark:text-black"]) expect(classes.has(c), c).toBe(true);
      for (const c of ["bg-amber-500", "bg-amber-600", "bg-primary"]) expect(classes.has(c), c).toBe(false);
    };
    readable(anyway);
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();

    await user.click(anyway);
    const submit = within(screen.getByRole("form", { name: "Approve anyway" })).getByRole("button", { name: "Approve anyway" });
    readable(submit);
    await user.click(submit);
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/approve", body: { state: "needs_human", gate: "merge" } }]));
  });

  it("says when GitHub can't be read, and the rest of the card and its actions still work", async () => {
    server.runs = [atMerge()];
    server.mergeGate["run-1"] = details({ pr: { number: 7, url: "https://github.com/acme/shop/pull/7" }, checks: null, githubError: "gh pr view failed: HTTP 502" });
    renderAt("/inbox");
    const user = userEvent.setup();

    const merge = await screen.findByLabelText("Merge details");
    expect(merge.textContent).toContain("Could not read GitHub: gh pr view failed: HTTP 502");
    expect(within(merge).getByRole("link", { name: "PR #7" })).toBeTruthy();
    expect(merge.textContent).toContain("code PASS");

    await user.click(screen.getByRole("button", { name: /Cancel run/ }));
    await user.click(within(screen.getByRole("form", { name: "Cancel run" })).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/cancel", body: { state: "needs_human", gate: "merge" } }]));
  });

  it("leaves cards at other gates as they were", async () => {
    server.runs = [runRow({ reason: "waiting at triage gate: gate is set to human" })];
    renderAt("/inbox");

    expect(await screen.findByText("waiting at triage gate: gate is set to human")).toBeTruthy();
    expect(screen.queryByLabelText("Merge details")).toBeNull();
    expect(server.gets.some((g) => g.endsWith("/merge-gate"))).toBe(false);
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
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-2/resume", body: { state: "needs_human", to: "triage", message: "try again", resetLoops: false } }]));

    await user.click(screen.getByRole("button", { name: /Cancel run/ }));
    await user.click(within(screen.getByRole("form", { name: "Cancel run" })).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(server.posts.at(-1)).toEqual({ path: "/api/projects/p1/runs/run-2/cancel", body: { state: "needs_human" } }));
  });

  it("shows what a run waiting for its author asked, and answers, triages again or cancels from there", async () => {
    server.runs = [runRow({ id: "run-3", issue: 13, state: "needs_info", waitingGate: null, reason: "triage needs more information" })];
    const detail = server.detail;
    server.detail = (run) => ({ ...detail(run), questions: ["Which broker comes first?", "Keep the ids?"] });
    server.answers.set("/answer", { continuation: "not_queued" });
    renderAt("/runs/p1/run-3");
    const user = userEvent.setup();

    const questions = await screen.findByRole("list", { name: "Questions for the issue's author" });
    expect(within(questions).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Which broker comes first?", "Keep the ids?"]);
    expect(screen.getByRole("link", { name: "on the issue" }).getAttribute("href")).toBe("https://github.com/acme/shop/issues/13");
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Answer/ }));
    const add = screen.getByRole("button", { name: "Add to the issue and triage again" });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText("Answers"), "Stake first. Keep them.");
    await user.click(add);
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-3/answer", body: { state: "needs_info", answer: "Stake first. Keep them." } }]));
    expect(await screen.findByText("Added your answers to the issue. Triage runs again once the issue is queued.")).toBeTruthy();

    server.posts = [];
    server.answers.set("/answer", { continuation: "unsafe" });
    await user.click(screen.getByRole("button", { name: /Triage again/ }));
    await user.click(within(screen.getByRole("form", { name: "Triage again" })).getByRole("button", { name: "Triage again" }));
    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-3/answer", body: { state: "needs_info" } }]));
    expect(await screen.findByText("Sent back to triage. It was started with --unsafe, so the worker leaves it: continue it with `factory run 13`.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Cancel run/ }));
    await user.click(within(screen.getByRole("form", { name: "Cancel run" })).getByRole("button", { name: "Cancel run" }));
    await waitFor(() => expect(server.posts.at(-1)).toEqual({ path: "/api/projects/p1/runs/run-3/cancel", body: { state: "needs_info" } }));
  });

  it("sends a run at a gate to the builder with its failure from the detail view", async () => {
    server.runs = [
      runRow({
        waitingGate: "review",
        resumeTargets: ["refine", "build"],
        capReached: "review round cap reached (3)",
        failure: { kind: "findings", source: "round-3/verify.md", items: [{ name: "code-1 (major)", summary: "the limiter is skipped" }] },
      }),
    ];
    renderAt("/runs/p1/run-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Send to builder with this failure/ }));
    await user.click(screen.getByRole("button", { name: "Send back" }));

    await waitFor(() =>
      expect(server.posts).toEqual([
        {
          path: "/api/projects/p1/runs/run-1/resume",
          body: {
            state: "needs_human",
            gate: "review",
            to: "build",
            message: "Fix the findings the verifier confirmed (see round-3/verify.md in the run folder):\n- code-1 (major): the limiter is skipped",
            resetLoops: true,
          },
        },
      ]),
    );
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

  it("closes the open file and forgets a confirmation when the page moves to another run", async () => {
    server.runs = [runRow(), runRow({ id: "run-2", issue: 13 })];
    server.files = { "triage.md": "DECISION: APPROVE" };
    const { navigate } = renderAt("/runs/p1/run-1");
    const user = userEvent.setup();

    await user.click(within(await screen.findByRole("list", { name: "Run files" })).getByRole("button", { name: "triage.md" }));
    expect(await screen.findByLabelText("Contents of triage.md")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Approve/ }));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approved.")).toBeTruthy();

    await navigate("/runs/p1/run-2");

    expect(await screen.findByRole("heading", { name: /#13/ })).toBeTruthy();
    expect(screen.queryByLabelText("Contents of triage.md")).toBeNull();
    expect(screen.queryByText("Approved.")).toBeNull();
  });

  it("confirms a decision while the run goes on, and drops it once the run waits for you elsewhere", async () => {
    server.runs = [runRow({ waitingGate: null, reason: "the build agent failed", resumeTargets: ["build", "triage"] })];
    renderAt("/runs/p1/run-1");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Resume/ }));
    await user.type(screen.getByLabelText("Reason"), "try again");
    // The server moves it on as the decision goes through.
    server.runs = [runRow({ state: "build", waitingGate: null, reason: "resumed" })];
    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Decision result" }).textContent).toBe("Sent to build."));

    // Later it parks at the merge gate: the old confirmation would describe the wrong decision.
    server.runs = [runRow({ waitingGate: "merge", reason: "waiting at merge gate" })];
    server.send({ type: "run", project: "shop", issue: 12, event: { type: "run:state", runId: "run-1", from: "build", to: "needs_human" } });
    expect(await screen.findByText("waiting at merge gate")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Decision result" }).textContent).toBe("");
  });

  it("says it is loading, encodes the project in the URL, and does not offer to open a binary file", async () => {
    server.runs = [runRow({ project: "p 1" })];
    server.files = { "triage.md": "x", "shot.png": "" };
    const detail = server.detail;
    server.detail = (run) => ({ ...detail(run), unshown: { "shot.png": "binary" } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      // The fake knows project "p1" only: answer for "p 1", but only if it arrived encoded.
      const url = String(input);
      if (url.includes("/api/projects/p%201/runs/run-1")) {
        await held;
        return server.fetch(url.replace("p%201", "p1"), init);
      }
      return server.fetch(input, init);
    });
    renderAt("/runs/p%201/run-1");

    expect(await screen.findByText("Loading the run...")).toBeTruthy();
    release();
    const files = await screen.findByRole("list", { name: "Run files" });
    expect(within(files).getByRole("button", { name: "triage.md" })).toBeTruthy();
    expect(within(files).queryByRole("button", { name: /shot\.png/ })).toBeNull();
    expect(within(files).getByText("(not text, open it from the run folder)")).toBeTruthy();
  });

  it("shows a finished run's leftover worktree and branch, and cleans them up", async () => {
    server.runs = [runRow({ state: "cancelled", waitingGate: null, reason: "not needed" })];
    const detail = server.detail;
    server.detail = (run) => ({ ...detail(run), leftover: { worktree: ".worktrees/run-1", branch: "factory/12-add", kept: "the branch has commits that are not on the remote" } });
    server.answers.set("/run-1/cleanup", { lines: ["run-1: kept: the branch has commits that are not on the remote"] });
    renderAt("/runs/p1/run-1");
    const user = userEvent.setup();

    expect(await screen.findByText(".worktrees/run-1")).toBeTruthy();
    expect(screen.getByText("factory/12-add")).toBeTruthy();
    expect(screen.getByText("Kept on purpose: the branch has commits that are not on the remote")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Clean up/ }));

    await waitFor(() => expect(server.posts).toEqual([{ path: "/api/projects/p1/runs/run-1/cleanup", body: { state: "cancelled" } }]));
    expect(within(await screen.findByRole("status", { name: "Cleanup result" })).getByText("run-1: kept: the branch has commits that are not on the remote")).toBeTruthy();
  });

  it("keeps saying what it removed once the run's worktree and branch are gone", async () => {
    server.runs = [runRow({ state: "done", waitingGate: null })];
    const detail = server.detail;
    let left = true;
    server.detail = (run) => ({ ...detail(run), ...(left ? { leftover: { worktree: ".worktrees/run-1", branch: "factory/12-add" } } : {}) });
    server.answers.set("/run-1/cleanup", { lines: ["run-1: removed worktree, local branch factory/12-add"] });
    renderAt("/runs/p1/run-1");
    const user = userEvent.setup();

    const clean = await screen.findByRole("button", { name: /Clean up/ });
    // The server removes them on the post, so every later read of the run has no leftover.
    left = false;
    await user.click(clean);

    expect(within(await screen.findByRole("status", { name: "Cleanup result" })).getByText("run-1: removed worktree, local branch factory/12-add")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(".worktrees/run-1")).toBeNull());
    expect(screen.getByRole("status", { name: "Cleanup result" }).textContent).toBe("run-1: removed worktree, local branch factory/12-add");
    expect(screen.queryByRole("button", { name: /Clean up/ })).toBeNull();
  });

  it("lists each acceptance criterion with its status and evidence, wrapping long paths", async () => {
    const evidence = "packages/core/src/pipeline/driver.acceptance.test.ts:123";
    server.runs = [runRow({ state: "build", waitingGate: null })];
    const detail = server.detail;
    server.detail = (run) => ({
      ...detail(run),
      sections: [
        {
          kind: "acceptance",
          path: "round-1/acceptance.json",
          count: "1/1 met, 1 for you to check",
          criteria: [
            { id: "AC-1", source: "issue", text: "ticks the met criteria", status: "MET", evidence },
            { id: "AC-2", source: "spec", text: "fits a phone screen", status: "CANNOT_CHECK", evidence: "needs a browser" },
          ],
        },
      ],
    });
    renderAt("/runs");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: /Add the feature/ }));

    expect(await screen.findByText("Acceptance criteria: 1/1 met, 1 for you to check")).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "Acceptance criteria" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([`AC-1metticks the met criteria${evidence}`, "AC-2for you to checkfits a phone screenneeds a browser"]);
    // A long path is one token: without break-words it would overflow the card at phone width.
    for (const li of items) expect(li.className.split(/\s+/)).toContain("break-words");
  });

  it("shows a run's re-syncs with the default branch next to its rounds, only once it has any", async () => {
    server.runs = [runRow({ id: "run-1", title: "Synced", state: "build", waitingGate: null, review: 3, resyncs: 2 }), runRow({ id: "run-2", title: "Plain", state: "build", waitingGate: null })];
    renderAt("/runs");
    const user = userEvent.setup();

    expect(await screen.findByText("b1 r3, 2 re-syncs")).toBeTruthy();
    expect(screen.getByText("b1 r1")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: /Synced/ }));
    expect(await screen.findByText("b1 r3, 2 re-syncs")).toBeTruthy();
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

  function issue(patch: Partial<BacklogIssue> & Pick<BacklogIssue, "number" | "title">): BacklogIssue {
    return {
      author: "alice",
      url: `https://github.com/acme/shop/issues/${patch.number}`,
      labels: [],
      queued: false,
      position: null,
      trusted: true,
      run: { id: `r${patch.number}`, state: "build", waitingGate: null },
      ...patch,
    };
  }

  it("says when the start limit holds the queue back, and when the next issue can start", async () => {
    const at = new Date(new Date().setHours(13, 53, 0, 0));
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    server.backlog = { ...server.backlog, issues: [issue({ number: 1, title: "Waiting one", queued: true, position: 1, run: null })], startLimit: { started: 10, max: 10, nextStartAt: at.toISOString() } };
    renderAt("/backlog");

    expect((await screen.findByRole("status")).textContent).toBe(
      `Start limit reached: 10 runs started in the last 24 h (github.max_starts_per_day). The next queued issue can start at ${time}.`,
    );
  });

  it("says nothing about the start limit when it isn't holding anything back", async () => {
    server.backlog = { ...server.backlog, issues: [issue({ number: 1, title: "Waiting one", queued: true, position: 1, run: null })] };
    renderAt("/backlog");

    await screen.findByText("Waiting one");
    expect(screen.queryByText(/Start limit/)).toBeNull();
  });

  it("shows each issue's labels and filters by one label without asking the server", async () => {
    server.backlog.issues = [
      issue({ number: 1, title: "Broken checkout", labels: ["bug", "Area: web"] }),
      issue({ number: 2, title: "New endpoint", labels: ["api"] }),
      issue({ number: 3, title: "Plain one" }),
    ];
    renderAt("/backlog");
    const user = userEvent.setup();

    const checkout = (await screen.findByText("Broken checkout")).closest("tr")!;
    expect(screen.getByRole("columnheader", { name: "Labels" })).toBeTruthy();
    expect([...checkout.querySelectorAll("td")][2]!.textContent).toBe("bugArea: web");
    expect(within(screen.getByText("New endpoint").closest("tr")!).getByText("api")).toBeTruthy();
    expect(within(screen.getByText("Plain one").closest("tr")!).getByText("none")).toBeTruthy();

    const filter = screen.getByRole("combobox", { name: "Filter by label" });
    expect(within(filter).getAllByRole("option").map((o) => o.textContent)).toEqual(["All labels", "api", "Area: web", "bug"]);
    const gets = server.gets.filter((p) => p === "/api/projects/p1/issues").length;

    await user.selectOptions(filter, "Area: web");
    expect(screen.getByText("Broken checkout")).toBeTruthy();
    expect(screen.queryByText("New endpoint")).toBeNull();
    expect(screen.queryByText("Plain one")).toBeNull();

    await user.selectOptions(filter, "");
    expect(screen.getByText("Broken checkout")).toBeTruthy();
    expect(screen.getByText("New endpoint")).toBeTruthy();
    expect(screen.getByText("Plain one")).toBeTruthy();

    expect(server.posts).toEqual([]);
    expect(server.gets.filter((p) => p === "/api/projects/p1/issues").length).toBe(gets);
  });

  it("falls back to all labels when a sync removes the chosen one, and hides the filter without labels", async () => {
    server.backlog.issues = [issue({ number: 1, title: "Broken checkout", labels: ["bug"] }), issue({ number: 2, title: "New endpoint", labels: ["api"] })];
    renderAt("/backlog");
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByRole("combobox", { name: "Filter by label" }), "bug");
    expect(screen.queryByText("New endpoint")).toBeNull();

    server.backlog = { ...server.backlog, issues: [issue({ number: 2, title: "New endpoint", labels: ["api"] }), issue({ number: 3, title: "Plain one" })] };
    await user.click(screen.getByRole("button", { name: /Sync now/ }));

    expect(await screen.findByText("Plain one")).toBeTruthy();
    expect(screen.getByText("New endpoint")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Filter by label" }) as HTMLSelectElement).value).toBe("");

    server.backlog = { ...server.backlog, issues: [issue({ number: 3, title: "Plain one" })] };
    await user.click(screen.getByRole("button", { name: /Sync now/ }));
    await waitFor(() => expect(screen.queryByText("New endpoint")).toBeNull());
    expect(screen.queryByRole("combobox", { name: "Filter by label" })).toBeNull();
  });

  it("links an issue only to GitHub", () => {
    const client = newQueryClient();
    const issues = [
      issue({ number: 1, title: "Synced" }),
      issue({ number: 2, title: "Imported, not synced yet", url: "" }),
      issue({ number: 3, title: "Crafted", url: "javascript:alert(1)" }),
    ];
    render(
      <QueryClientProvider client={client}>
        <BacklogTable project="p1" issues={issues} label="" />
      </QueryClientProvider>,
    );

    const href = (title: string) => within(screen.getByText(title).closest("tr")!).getByText(/^#\d+$/).getAttribute("href");
    expect(href("Synced")).toBe("https://github.com/acme/shop/issues/1");
    expect(href("Imported, not synced yet")).toBeNull();
    expect(href("Crafted")).toBeNull();
  });

  it("says so when no issue carries the chosen label", () => {
    const client = newQueryClient();
    render(
      <QueryClientProvider client={client}>
        <BacklogTable project="p1" issues={[issue({ number: 1, title: "Broken checkout", labels: ["bug"] })]} label="docs" />
      </QueryClientProvider>,
    );

    expect(screen.getByText("No open issues with label docs.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/No open issues synced/)).toBeNull();
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

  it("cleans up finished runs, lists the ones left alone, and cleans those up on request", async () => {
    server.runs = [runRow({ state: "done", waitingGate: null })];
    server.answers.set("/p1/cleanup", { lines: ["run-0: removed worktree, local branch factory/3-x"], skipped: [{ runId: "run-1", why: "finished 40s ago; cleaned up 2 minutes after it finished", recent: true }] });
    renderAt("/runs");
    const user = userEvent.setup();

    // Finished runs are under All.
    expect(screen.queryByRole("button", { name: /Clean up finished runs/ })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "All" }));
    await user.click(await screen.findByRole("button", { name: /Clean up finished runs/ }));

    const status = await screen.findByRole("status");
    expect(within(status).getByText("run-0: removed worktree, local branch factory/3-x")).toBeTruthy();
    expect(status.textContent).toContain("run-1: finished 40s ago; cleaned up 2 minutes after it finished");
    await user.click(screen.getByRole("button", { name: "Also clean up the runs that just finished" }));
    await waitFor(() =>
      expect(server.posts).toEqual([
        { path: "/api/projects/p1/cleanup", body: { now: false } },
        { path: "/api/projects/p1/cleanup", body: { now: true } },
      ]),
    );
  });

  it("reports each project's cleanup on its own, keeping what the others did when one fails", async () => {
    server.projects = [PROJECT, { key: "p2", name: "blog", path: "/repos/blog", status: "ok" }];
    server.answers.set("/p1/cleanup", { lines: ["run-0: removed worktree"], skipped: [] });
    server.failures.set("/p2/cleanup", { status: 500, error: "git is locked" });
    renderAt("/runs");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "All" }));
    await user.click(await screen.findByRole("button", { name: /Clean up finished runs/ }));

    const status = screen.getByRole("status");
    expect(await within(status).findByText("run-0: removed worktree")).toBeTruthy();
    expect(within(status).getByRole("heading", { name: "shop" })).toBeTruthy();
    expect(within(status).getByRole("heading", { name: "blog" })).toBeTruthy();
    expect(within(status).getByRole("alert").textContent).toBe("git is locked");
  });

  it("forgets a cleanup's outcome when another project is picked", async () => {
    server.projects = [PROJECT, { key: "p2", name: "blog", path: "/repos/blog", status: "ok" }];
    server.answers.set("/p1/cleanup", { lines: [], skipped: [{ runId: "run-1", why: "finished 4s ago", recent: true }] });
    renderAt("/runs");
    const user = userEvent.setup();

    await screen.findByRole("option", { name: "blog" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p1");
    await user.click(await screen.findByRole("button", { name: "All" }));
    await user.click(await screen.findByRole("button", { name: /Clean up finished runs/ }));
    expect(await screen.findByRole("button", { name: "Also clean up the runs that just finished" })).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p2");
    expect(screen.queryByText(/finished 4s ago/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Also clean up the runs that just finished" })).toBeNull();
  });
});

const SECTIONS = "## Why\nBecause.\n\n## What\nDo it.\n\n## Acceptance criteria\n- [ ] it works\n\n## Scope\nThis.\n\n## Out of scope\nThat.";

function draftView(patch: Partial<DraftView> = {}): DraftView {
  return {
    project: "p1",
    projectName: "shop",
    id: "draft-1a2b3c4d",
    idea: "Export orders as CSV",
    createdAt: new Date().toISOString(),
    running: false,
    draft: {
      decision: "PROCEED",
      summary: ["one issue"],
      reasons: [],
      issue: { title: "Add CSV export", ui: false, risk: "LOW", labels: [], dependsOn: [], body: SECTIONS },
      subIssues: [],
    },
    problems: [],
    refusal: null,
    created: [],
    ...patch,
  };
}

describe("new issue", () => {
  it("starts the issue writer, follows it live, refuses a broken edit with the reason, and creates the issue", async () => {
    const id = "draft-1a2b3c4d";
    server.answers.set("/p1/drafts", { id, ignored: [] });
    server.draftDetails[id] = {
      project: "p1",
      projectName: "shop",
      id,
      pending: { ...draftView({ running: true, draft: null }), text: null },
      job: { running: true, events: [{ type: "agent:start", runId: id, role: "issue_writer" }] },
    };
    renderAt("/inbox");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("link", { name: /New issue/ }));
    await user.type(await screen.findByLabelText("Idea"), "Export orders as CSV");
    await user.click(screen.getByLabelText(/Queue the issues/));
    await user.click(screen.getByRole("button", { name: /Start the issue writer/ }));

    expect(await screen.findByText("issue_writer started")).toBeTruthy();
    expect(server.posts).toEqual([{ path: "/api/projects/p1/drafts", body: { idea: "Export orders as CSV", queue: true } }]);
    await waitFor(() => expect(screen.getByTitle("Live")).toBeTruthy());
    server.send({ type: "draft", project: "p1", draftId: id, event: { type: "agent:activity", runId: id, agentRunId: "a", summary: "Reading src/orders.ts" } });
    expect(await screen.findByText("Reading src/orders.ts")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop the issue writer/ })).toBeTruthy();

    // The gate wants a human: the draft comes up as fields.
    const text = "DECISION: PROCEED\n\n=== ISSUE ===\nTITLE: Add CSV export\n";
    server.draftDetails[id] = {
      ...server.draftDetails[id]!,
      pending: { ...draftView(), text },
      job: { running: false, events: [], result: { kind: "waiting", reasons: ["gate is set to human"] } },
    };
    server.send({ type: "draft:done", project: "p1", draftId: id, result: { kind: "waiting", reasons: ["gate is set to human"] } });
    expect(await screen.findByText("Waiting for you: gate is set to human")).toBeTruthy();
    const title = screen.getByLabelText("Issue title");
    expect((title as HTMLInputElement).value).toBe("Add CSV export");

    const body = screen.getByLabelText("Issue body");
    await user.clear(body);
    await user.click(body);
    await user.paste("## Why\nBecause.");
    const refusal = `Draft ${id} is not valid:\n- issue: section ## Acceptance criteria is missing\nNothing was saved. Fix it and save it again, or discard it.`;
    server.failures.set("/save", { status: 400, error: refusal });
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(refusal);
    expect(server.posts.at(-1)).toEqual({
      path: `/api/projects/p1/drafts/${id}/save`,
      body: { issue: { title: "Add CSV export", ui: false, risk: "LOW", body: "## Why\nBecause.", labels: [] }, subIssues: [] },
    });

    server.failures.delete("/save");
    await user.clear(body);
    await user.click(body);
    await user.paste(SECTIONS);
    await user.clear(title);
    await user.type(title, "Export orders as CSV");
    const published = { issue: { number: 20, title: "Export orders as CSV", url: "https://github.com/acme/shop/issues/20" }, subIssues: [], buildable: [20], queued: [] };
    server.answers.set("/publish", published);
    server.draftDetails[id] = { ...server.draftDetails[id]!, pending: null, job: { running: false, events: [], result: { kind: "published", published } } };
    await user.click(screen.getByRole("button", { name: /Save and create on GitHub/ }));

    expect(await screen.findByText("Created on GitHub")).toBeTruthy();
    expect(screen.getByRole("link", { name: /#20\s*Export orders as CSV/ }).getAttribute("href")).toBe("https://github.com/acme/shop/issues/20");
    expect(screen.getByText(/Not queued/)).toBeTruthy();
    expect(server.posts.slice(-2)).toEqual([
      { path: `/api/projects/p1/drafts/${id}/save`, body: { issue: { title: "Export orders as CSV", ui: false, risk: "LOW", body: SECTIONS, labels: [] }, subIssues: [] } },
      { path: `/api/projects/p1/drafts/${id}/publish`, body: { queue: false } },
    ]);
  });

  it("edits sub-issues and what they depend on, and shows the issues a gate let through", async () => {
    const id = "draft-1a2b3c4d";
    const big = draftView({
      draft: {
        decision: "ESCALATE",
        summary: [],
        reasons: ["the export format is a guess"],
        issue: { title: "Exports", ui: false, risk: "LOW", labels: ["enhancement"], dependsOn: [], body: SECTIONS },
        subIssues: [
          { title: "CSV export", ui: false, risk: "LOW", labels: [], dependsOn: [], body: SECTIONS },
          { title: "Excel export", ui: true, risk: "MEDIUM", labels: ["ui"], dependsOn: [1], body: SECTIONS },
        ],
      },
    });
    server.draftDetails[id] = { project: "p1", projectName: "shop", id, pending: { ...big, text: "x" }, job: null };
    renderAt(`/new/p1/${id}`);
    const user = userEvent.setup();

    expect(await screen.findByText("the export format is a guess")).toBeTruthy();
    expect((screen.getByLabelText("Sub-issue 2 depends on") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("Parent issue labels") as HTMLInputElement).value).toBe("enhancement");
    expect((screen.getByLabelText("Sub-issue 2 labels") as HTMLInputElement).value).toBe("ui");
    await user.type(screen.getByLabelText("Sub-issue 1 labels"), "bug, , tests ");
    await user.selectOptions(screen.getByLabelText("Sub-issue 1 risk"), "HIGH");
    await user.type(screen.getByLabelText("Sub-issue 2 depends on"), ", x");
    expect((await screen.findByRole("alert")).textContent).toBe("sub-issue 2: DEPENDS_ON x is not a sub-issue number");
    await user.clear(screen.getByLabelText("Sub-issue 2 depends on"));
    await user.type(screen.getByLabelText("Sub-issue 2 depends on"), "#1");
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(server.posts).toEqual([
        {
          path: `/api/projects/p1/drafts/${id}/save`,
          body: {
            issue: { title: "Exports", ui: false, risk: "LOW", body: SECTIONS, labels: ["enhancement"] },
            subIssues: [
              { title: "CSV export", ui: false, risk: "HIGH", body: SECTIONS, labels: ["bug", "tests"], dependsOn: [] },
              { title: "Excel export", ui: true, risk: "MEDIUM", body: SECTIONS, labels: ["ui"], dependsOn: [1] },
            ],
          },
        },
      ]),
    );

    cleanup();
    const published = {
      issue: { number: 20, title: "Exports", url: "https://github.com/acme/shop/issues/20" },
      subIssues: [
        { number: 21, title: "CSV export", url: "https://github.com/acme/shop/issues/21" },
        { number: 22, title: "Excel export", url: "javascript:alert(1)" },
      ],
      buildable: [21, 22],
      queued: [21, 22],
    };
    server.draftDetails[id] = { project: "p1", projectName: "shop", id, pending: null, job: { running: false, events: [], result: { kind: "published", published } } };
    renderAt(`/new/p1/${id}`);
    expect(await screen.findByText("Queued #21, #22 for the factory.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /#21\s*CSV export/ })).toBeTruthy();
    // Only GitHub pages are linked.
    expect(screen.queryByRole("link", { name: /#22/ })).toBeNull();
    expect(screen.getByText("Excel export")).toBeTruthy();
  });

  it("keeps the newest progress line in view, unless the person scrolled up to read", async () => {
    const id = "draft-1a2b3c4d";
    const activity = (summary: string) => ({ type: "agent:activity", runId: id, agentRunId: "a", summary });
    server.draftDetails[id] = {
      project: "p1",
      projectName: "shop",
      id,
      pending: { ...draftView({ running: true, draft: null }), text: null },
      job: { running: true, events: Array.from({ length: 30 }, (_, i) => activity(`step ${i}`)) },
    };
    renderAt(`/new/p1/${id}`);

    const list = await screen.findByRole("list", { name: "Issue writer's progress" });
    // jsdom has no layout: a 16rem box over a taller list, where each line adds 20px.
    let scrollTop = 0;
    Object.defineProperties(list, {
      clientHeight: { configurable: true, get: () => 256 },
      scrollHeight: { configurable: true, get: () => list.querySelectorAll("li").length * 20 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (v: number) => void (scrollTop = v) },
    });
    await waitFor(() => expect(screen.getByTitle("Live")).toBeTruthy());

    server.send({ type: "draft", project: "p1", draftId: id, event: activity("Reading src/orders.ts") });
    expect(await within(list).findByText("Reading src/orders.ts")).toBeTruthy();
    expect(scrollTop).toBe(list.scrollHeight);

    // Scrolled up to an earlier line: a new one does not pull the box back down.
    scrollTop = 0;
    act(() => void list.dispatchEvent(new Event("scroll")));
    server.send({ type: "draft", project: "p1", draftId: id, event: activity("Writing the draft") });
    expect(await within(list).findByText("Writing the draft")).toBeTruthy();
    expect(scrollTop).toBe(0);

    // Back at the bottom: it follows again.
    scrollTop = list.scrollHeight - list.clientHeight;
    act(() => void list.dispatchEvent(new Event("scroll")));
    server.send({ type: "draft", project: "p1", draftId: id, event: activity("Checking the sections") });
    expect(await within(list).findByText("Checking the sections")).toBeTruthy();
    expect(scrollTop).toBe(list.scrollHeight);
  });

  it("shows why the issue writer failed, and discards the draft it left", async () => {
    const id = "draft-1a2b3c4d";
    const error = "The issue writer failed (aborted). Drop the draft with `factory new --discard draft-1a2b3c4d`.";
    server.draftDetails[id] = {
      project: "p1",
      projectName: "shop",
      id,
      pending: { ...draftView({ draft: null, problems: ["the issue writer did not write a draft"] }), text: null },
      job: { running: false, events: [], result: { kind: "failed", error } },
    };
    renderAt(`/new/p1/${id}`);
    const user = userEvent.setup();

    expect((await screen.findByRole("alert")).textContent).toBe(error);
    expect(screen.getByText("the issue writer did not write a draft")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create on GitHub/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Discard/ }));
    await waitFor(() => expect(server.posts).toEqual([{ path: `/api/projects/p1/drafts/${id}/discard`, body: {} }]));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeTruthy();
  });

  it("lists pending drafts in the Inbox, each opening its draft; a refused one says why and can't be created", async () => {
    const refusal = ".factory/drafts/draft-9f9f9f9f/draft.md is tracked by git, so the draft may come from someone else's commit";
    server.drafts = [draftView(), draftView({ id: "draft-9f9f9f9f", idea: "planted", refusal })];
    server.draftDetails["draft-9f9f9f9f"] = { project: "p1", projectName: "shop", id: "draft-9f9f9f9f", pending: { ...server.drafts[1]!, text: "DECISION: PROCEED\n" }, job: null };
    renderAt("/inbox");
    const user = userEvent.setup();

    const list = await screen.findByRole("list", { name: "Pending drafts" });
    const links = within(list).getAllByRole("link", { name: "Add CSV export" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/new/p1/draft-1a2b3c4d", "/new/p1/draft-9f9f9f9f"]);
    expect(within(list).getByText(/waiting for you · shop/)).toBeTruthy();
    expect(within(list).getByText(/refused: tracked by git · shop/)).toBeTruthy();
    await user.click(links[1]!);

    expect(await screen.findByText(`This draft can't be created: ${refusal}.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Create on GitHub|^Save$/ })).toBeNull();
    expect(screen.getByLabelText("Draft text").textContent).toBe("DECISION: PROCEED\n");
  });
});

describe("settings", () => {
  const HEAD = "b".repeat(40);
  function settingsPage(patch: Partial<ProjectSettings> = {}): ProjectSettings {
    return {
      branch: "main",
      head: HEAD,
      sections: [
        { key: "gates", title: "Gates", about: "Where a run stops for you." },
        { key: "loops", title: "Loops", about: "How often a run may go back." },
        { key: "trust", title: "Trust", about: "Whose issues count as the spec." },
        { key: "project", title: "Project", about: "The project." },
      ],
      settings: [
        {
          path: "gates.merge",
          section: "gates",
          label: "merge",
          help: "Before the PR is merged.",
          kind: { type: "enum", options: ["always", "auto", "human"] },
          sensitive: "A gate that no longer stops for you lets runs go past that point on their own.",
          value: "human",
          effective: "human",
          default: "human",
        },
        { path: "loops.max_review_rounds", section: "loops", label: "Review rounds", help: "Confirmed findings sending the build back.", kind: { type: "integer", min: 1 }, effective: 3, default: 3 },
        { path: "trust.authors", section: "trust", label: "Trusted authors", help: "Logins.", kind: { type: "list" }, sensitive: "Trusted issues can lead to a build.", value: ["alice"], effective: ["alice"], default: [] },
        { path: "project.default_branch", section: "project", label: "Default branch", help: "The branch.", kind: { type: "string" }, readOnly: "Change it in the file itself.", effective: "main", default: "main" },
      ],
      builtinPaths: [".factory/**"],
      problems: [],
      ...patch,
    };
  }

  it("shows each setting with its default, and saves the changes to the default branch after listing them", async () => {
    server.settings = settingsPage();
    server.answers.set("/settings", { commit: "c".repeat(40), branch: "main", changed: ["gates.merge", "loops.max_review_rounds"] });
    renderAt("/settings");
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Gates" })).toBeTruthy();
    expect(screen.getByText("Change it in the file itself.")).toBeTruthy();
    expect((screen.getByLabelText("Review rounds") as HTMLInputElement).placeholder).toBe("3");
    expect(screen.queryByRole("button", { name: /Review and save/ })).toBeNull();

    await user.selectOptions(screen.getByLabelText("merge"), "auto");
    await user.type(screen.getByLabelText("Review rounds"), "5");
    expect(screen.getByText("2 changes")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Review and save/ }));

    const confirm = screen.getByRole("group", { name: "Confirm the changes" });
    expect(within(confirm).getByText(/Commit and push these 2 changes to main\?/)).toBeTruthy();
    expect(confirm.textContent).toContain("gates.merge: human to auto");
    expect(confirm.textContent).toContain("loops.max_review_rounds: 3 to 5");
    expect(within(confirm).getByText(/lets runs go past that point on their own/)).toBeTruthy();
    await user.click(within(confirm).getByRole("button", { name: "Save to main" }));

    await waitFor(() =>
      expect(server.posts).toEqual([
        { path: "/api/projects/p1/settings", body: { head: HEAD, changes: [{ path: "gates.merge", value: "auto" }, { path: "loops.max_review_rounds", value: 5 }] } },
      ]),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(/^Saved as commit ccccccc on main\. Runs use it from now on/);
  });

  it("takes a setting back to its default, drops an edit undone by hand, and discards", async () => {
    server.settings = settingsPage();
    renderAt("/settings");
    const user = userEvent.setup();

    const authors = await screen.findByLabelText("Trusted authors");
    await user.type(authors, "\nbob");
    expect(screen.getByText("1 change")).toBeTruthy();
    await user.type(authors, "{Backspace}{Backspace}{Backspace}{Backspace}");
    expect(screen.queryByText("1 change")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Use the default for Trusted authors" }));
    await user.click(screen.getByRole("button", { name: /Review and save/ }));
    expect(screen.getByRole("group", { name: "Confirm the changes" }).textContent).toContain("trust.authors: alice to the default (none)");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("1 change")).toBeNull();
    expect((screen.getByLabelText("Trusted authors") as HTMLTextAreaElement).value).toBe("alice");
  });

  it("keeps edits in progress while runs move on, and keeps focus with the confirmation", async () => {
    server.settings = settingsPage();
    renderAt("/settings");
    const user = userEvent.setup();

    await user.selectOptions(await screen.findByLabelText("merge"), "auto");
    server.send({ type: "run", project: "shop", issue: 12, event: { type: "run:state", runId: "run-1", from: "build", to: "review" } });
    await waitFor(() => expect(server.gets.filter((p) => p === "/api/runs").length).toBeGreaterThan(0));
    expect(server.gets.filter((p) => p === "/api/projects/p1/settings")).toHaveLength(1);
    expect((screen.getByLabelText("merge") as HTMLSelectElement).value).toBe("auto");

    await user.click(screen.getByRole("button", { name: /Review and save/ }));
    expect(document.activeElement).toBe(screen.getByRole("group", { name: "Confirm the changes" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Review and save/ }));
  });

  it("shows a value of the wrong shape as it is rather than breaking, and lets a list be emptied", async () => {
    server.settings = settingsPage({
      settings: [
        { path: "trust.authors", section: "trust", label: "Trusted authors", help: "Logins.", kind: { type: "list" }, value: "alice", effective: [], default: [] },
        {
          path: "merge.comment_bots",
          section: "trust",
          label: "Comment bots",
          help: "Apps.",
          kind: { type: "list" },
          value: ["github-advanced-security[bot]"],
          effective: ["github-advanced-security[bot]"],
          default: ["github-advanced-security[bot]"],
        },
      ],
    });
    renderAt("/settings");
    const user = userEvent.setup();

    expect(await screen.findByText(/which isn't valid here/)).toBeTruthy();
    await user.clear(screen.getByLabelText("Comment bots"));
    await user.click(screen.getByRole("button", { name: /Review and save/ }));
    expect(screen.getByRole("group", { name: "Confirm the changes" }).textContent).toContain("merge.comment_bots: github-advanced-security[bot] to none");
  });

  it("offers to reload when the settings changed on the branch meanwhile, and shows why a file on the branch is invalid", async () => {
    server.settings = settingsPage({ problems: ["origin/main:.factory/config.yaml: loops.max_review_rounds: Too small"] });
    server.failures.set("/settings", { status: 409, error: "The settings on main changed since you opened them." });
    renderAt("/settings");
    const user = userEvent.setup();

    expect((await screen.findByRole("alert")).textContent).toContain("loops.max_review_rounds: Too small");
    await user.selectOptions(screen.getByLabelText("merge"), "always");
    await user.click(screen.getByRole("button", { name: /Review and save/ }));
    await user.click(screen.getByRole("button", { name: "Save to main" }));

    expect(await screen.findByText("The settings on main changed since you opened them.")).toBeTruthy();
    server.settings = settingsPage({ head: "d".repeat(40) });
    await user.click(screen.getByRole("button", { name: /Reload the settings/ }));
    await waitFor(() => expect(screen.queryByText(/changed since you opened them/)).toBeNull());
    expect((screen.getByLabelText("merge") as HTMLSelectElement).value).toBe("human");
  });
});

describe("audits", () => {
  const summary = { id: "20261127-103000", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), commit: "abc123def456", effort: "medium", status: "complete" as const, notes: [] };
  const finding = { id: "security-scan-1a2b3c4d", severity: "critical" as const, claim: "Command injection in ping", evidence: "host from the query goes to execSync", file: "server.js", line: 7 };

  function withAudit() {
    server.audits = { schedule: "weekly", github: "acme/shop", audits: [{ ...summary, findings: 1 }, { ...summary, id: "20261120-090000", status: "skipped", problem: "the claude-security Claude Code plugin is not installed", findings: 0 }] };
    server.auditDetails[summary.id] = { ...summary, findings: [finding] };
  }

  it("lists the audits with the schedule, and the newest audit's findings with their evidence", async () => {
    withAudit();
    renderAt("/audits");

    expect(await screen.findByText("Audited every week by factory serve and factory work.")).toBeTruthy();
    expect(screen.getByText("1 finding")).toBeTruthy();
    expect(screen.getByText("the claude-security Claude Code plugin is not installed")).toBeTruthy();
    expect(await screen.findByText("Command injection in ping")).toBeTruthy();
    expect(screen.getByText("server.js:7")).toBeTruthy();
    expect(screen.getByText("host from the query goes to execSync")).toBeTruthy();
  });

  it("says when there are none, and asks for one now", async () => {
    renderAt("/audits");
    expect(await screen.findByText("No audits yet.")).toBeTruthy();
    expect(screen.getByText("Scheduled audits are off. Turn them on in Settings, under Security.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Run audit now" }));
    await waitFor(() => expect(server.posts.map((p) => p.path)).toEqual(["/api/projects/p1/audits"]));
  });

  it("can't ask for another while one is going on", async () => {
    server.audits = { ...server.audits, state: "running" };
    renderAt("/audits");
    expect(await screen.findByText("Audit going on")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Run audit now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("files a finding, and on a public repository asks first", async () => {
    withAudit();
    server.publicRepo = true;
    renderAt("/audits");

    await userEvent.click(await screen.findByRole("button", { name: "File issue" }));
    const warning = await screen.findByRole("alert");
    expect(within(warning).getByText(/This repository is public/)).toBeTruthy();
    expect(server.posts).toEqual([{ path: "/api/projects/p1/audits/20261127-103000/findings/security-scan-1a2b3c4d/file", body: { public: false } }]);

    server.auditDetails[summary.id] = { ...summary, findings: [{ ...finding, issue: 31 }] };
    await userEvent.click(within(warning).getByRole("button", { name: "File anyway" }));
    expect(server.posts[1]!.body).toEqual({ public: true });
    const link = await screen.findByRole("link", { name: /Issue #31/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/shop/issues/31");
  });

  it("says when filing anyway failed, and can't be cancelled while it files", async () => {
    withAudit();
    server.publicRepo = true;
    server.failures.set("/file", { status: 502, error: "GitHub: gh issue create failed" });
    renderAt("/audits");

    await userEvent.click(await screen.findByRole("button", { name: "File issue" }));
    const warning = await screen.findByRole("alert");
    await userEvent.click(within(warning).getByRole("button", { name: "File anyway" }));
    expect(await screen.findByText("GitHub: gh issue create failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "File issue" })).toBeTruthy();
  });

  it("says why the last audit couldn't start, and shows notes and the whole reason of the one picked", async () => {
    const problem = `the scan failed: ${"a long reason ".repeat(20)}`.trim();
    server.audits = {
      schedule: "weekly",
      github: "acme/shop",
      failed: "git fetch failed: offline",
      audits: [
        { ...summary, notes: ["the temporary worktree could not be removed"], findings: 0 },
        { ...summary, id: "20261120-090000", status: "failed", problem, findings: 0 },
      ],
    };
    server.auditDetails[summary.id] = { ...summary, notes: ["the temporary worktree could not be removed"], findings: [] };
    renderAt("/audits");

    expect(await screen.findByText("The last audit could not start: git fetch failed: offline")).toBeTruthy();
    expect(await screen.findByText("the temporary worktree could not be removed")).toBeTruthy();
    expect(screen.getByText("This audit reported no findings.")).toBeTruthy();

    await userEvent.click(screen.getAllByRole("row")[2]!);
    // The table cell and the full text below it.
    await waitFor(() => expect(screen.getAllByText(problem)).toHaveLength(2));
  });
});
