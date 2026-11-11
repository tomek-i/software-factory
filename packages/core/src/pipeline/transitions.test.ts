import { describe, expect, it } from "vitest";
import { factoryConfigSchema, parseVerdict, type RunState } from "@factory/shared";
import { Store, type StatePatch } from "../store/store.js";
import { allowedTargets, resumeTargets, RunMachine, TransitionError, type Evidence } from "./transitions.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const major = '```json\n[{"id":"F1","severity":"major","claim":"bug","evidence":"line 3"}]\n```';

const FILES = {
  triage: "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n",
  critic: "VERDICT: ACCEPT\n",
  build: `STATUS: READY\nCOMMIT: ${HEAD}\n`,
  checks: `GATE: PASS\nCOMMIT: ${HEAD}\n`,
  verify: "VERDICT: NONE_CONFIRMED\n",
};

function fakeEvidence(
  overrides: {
    files?: Partial<Record<keyof typeof FILES, string | undefined>>;
    reviews?: string[];
    head?: string;
    clean?: boolean;
    ahead?: number;
    pushed?: boolean;
  } = {},
): Evidence {
  const files: Record<string, string | undefined> = { ...FILES, ...overrides.files };
  return {
    verdict: (kind) => {
      const text = files[kind];
      if (text === undefined) throw new Error(`${kind} output missing`);
      return parseVerdict(kind, text);
    },
    reviews: () => (overrides.reviews ?? ["VERDICT: PASS\n"]).map((t) => parseVerdict("review", t)),
    git: {
      head: () => overrides.head ?? HEAD,
      isClean: () => overrides.clean ?? true,
      commitsAhead: () => overrides.ahead ?? 1,
      isPushed: () => overrides.pushed ?? true,
    },
  };
}

function setup(configOverrides: object = {}) {
  const store = new Store(":memory:");
  const config = factoryConfigSchema.parse({ version: 1, ...configOverrides });
  const project = store.upsertProject({ name: "demo", repo_path: "/repo" });
  const run = store.createRun({ project_id: project.id, title: "t", issue_number: 1 });
  const machine = new RunMachine(store, config);
  const at = (state: RunState, patch: StatePatch = {}) => store.writeState(run.id, state, patch);
  const move = (to: RunState, evidence: Evidence = fakeEvidence()) =>
    machine.transition(run.id, to, { reason: "test", evidence });
  return { store, machine, run, at, move };
}

describe("allowedTargets", () => {
  it("lets every active state escalate, fail or be cancelled", () => {
    expect(allowedTargets("build")).toEqual(expect.arrayContaining(["needs_human", "failed", "cancelled"]));
  });

  it("allows nothing out of terminal states, and nothing automatic out of needs_human", () => {
    expect(allowedTargets("done")).toEqual([]);
    expect(allowedTargets("needs_human")).toEqual([]);
  });
});

describe("RunMachine.transition", () => {
  it("moves along a valid edge and records the event", () => {
    const { machine, store, run } = setup();
    const moved = machine.transition(run.id, "triage", { reason: "admitted", data: { by: "test" } });

    expect(moved.state).toBe("triage");
    expect(store.listEvents(run.id).at(-1)).toMatchObject({ from_state: "intake", to_state: "triage", reason: "admitted" });
  });

  it("rejects edges that do not exist", () => {
    const { machine, run } = setup();
    expect(() => machine.transition(run.id, "merge", { reason: "skip ahead" })).toThrow(TransitionError);
  });

  it("requires evidence for guarded edges", () => {
    const { machine, run, at } = setup();
    at("build");
    expect(() => machine.transition(run.id, "gate", { reason: "built" })).toThrow(/evidence is required/);
  });

  it("only leaves triage for refine or critic when triage approved", () => {
    const { at, move } = setup();
    at("triage");
    expect(() => move("critic", fakeEvidence({ files: { triage: FILES.triage.replace("APPROVE", "REJECT") } }))).toThrow(
      /did not APPROVE/,
    );
    expect(move("critic").state).toBe("critic");
  });

  it("only builds once the spec critic accepted", () => {
    const { at, move } = setup();
    at("critic");
    expect(() => move("build", fakeEvidence({ files: { critic: "VERDICT: REVISE\n" } }))).toThrow(/did not ACCEPT/);
    expect(move("build").state).toBe("build");
  });

  it("only lets the builder hand over a clean, committed, pushed branch it reported on", () => {
    const { at, move } = setup();
    at("build");
    const bad = fakeEvidence({
      files: { build: `STATUS: BLOCKED\nCOMMIT: ${OLD}\n` },
      clean: false,
      ahead: 0,
      pushed: false,
    });

    try {
      move("gate", bad);
      expect.unreachable();
    } catch (err) {
      expect((err as TransitionError).problems).toEqual([
        "builder did not report STATUS: READY",
        "builder's report is for a different commit than HEAD",
        "branch has no commits ahead of the base branch",
        "worktree has uncommitted changes",
        "branch is not pushed to origin",
      ]);
    }
    expect(move("gate").state).toBe("gate");
  });

  it("refuses to review a commit the gate did not check, or an unpushed branch", () => {
    const { at, move } = setup();
    at("gate");
    expect(() => move("review", fakeEvidence({ head: OLD }))).toThrow(/HEAD is bbbbbbb/);
    expect(() => move("review", fakeEvidence({ pushed: false }))).toThrow(/not pushed/);
  });

  it("refuses to leave review while confirmed findings are unresolved", () => {
    const { at, move } = setup();
    at("review");
    const changes = [`VERDICT: CHANGES\n\n## Findings\n${major}\n`];
    const confirmed = `VERDICT: CONFIRMED\n\n## Findings\n${major}\n`;

    expect(() => move("capture", fakeEvidence({ reviews: changes, files: { verify: confirmed } }))).toThrow(
      /verifier confirmed findings/,
    );
    expect(() => move("capture", fakeEvidence({ reviews: [] }))).toThrow(/no review results/);
    // All blocking findings refuted by the verifier: the run may continue.
    expect(move("capture", fakeEvidence({ reviews: changes })).state).toBe("capture");
  });

  it("refuses to move past review if new commits landed after the gate", () => {
    const { at, move } = setup();
    at("review");
    expect(() => move("capture", fakeEvidence({ head: OLD }))).toThrow(TransitionError);
  });

  it("only sends review work back to the builder when findings were confirmed", () => {
    const { at, move } = setup();
    at("review");
    expect(() => move("build")).toThrow(/no confirmed findings/);
    const confirmed = `VERDICT: CONFIRMED\n\n## Findings\n${major}\n`;
    expect(move("build", fakeEvidence({ files: { verify: confirmed } })).review_rounds).toBe(1);
  });

  it("caps builds at max_build_iterations total attempts", () => {
    const { machine, store, run, at, move } = setup({ loops: { max_build_iterations: 3 } });
    const failed = fakeEvidence({ files: { checks: `GATE: FAIL\nCOMMIT: ${HEAD}\n` } });

    // Build 1 failed -> rebuild (build 2), failed -> rebuild (build 3), failed -> cap.
    for (let i = 1; i <= 2; i++) {
      at("gate");
      expect(move("build", failed).build_iterations).toBe(i);
    }
    at("gate");
    expect(() => move("build", failed)).toThrow(/build iteration cap reached \(3\)/);
    expect(machine.transition(run.id, "needs_human", { reason: "cap reached" }).parked_from).toBe("gate");
    expect(store.getRun(run.id)!.build_iterations).toBe(2);
  });

  it("caps review rounds, including failed merge attempts", () => {
    const { at, move } = setup({ loops: { max_review_rounds: 2 } });
    at("merge");
    expect(move("build").review_rounds).toBe(1);
    at("merge");
    expect(() => move("build")).toThrow(/review round cap reached/);
  });

  it("caps spec critic rounds and needs a REVISE verdict to loop", () => {
    const { at, move } = setup({ loops: { max_critic_rounds: 2 } });
    const revise = fakeEvidence({ files: { critic: "VERDICT: REVISE\n" } });
    at("critic");
    expect(() => move("refine")).toThrow(/did not ask to REVISE/);
    expect(move("refine", revise).critic_rounds).toBe(1);
    at("critic");
    expect(() => move("refine", revise)).toThrow(/critic round cap/);
  });

  it("does not let callers reset loop counters through the patch", () => {
    const { machine, run, at } = setup({ loops: { max_build_iterations: 2 } });
    const failed = fakeEvidence({ files: { checks: `GATE: FAIL\nCOMMIT: ${HEAD}\n` } });
    at("gate", { build_iterations: 1 });
    const patch = { build_iterations: 0 } as unknown as { title: string };
    expect(() => machine.transition(run.id, "build", { reason: "x", evidence: failed, patch })).toThrow(/cap reached/);
  });

  it("ignores undefined patch values instead of clearing columns", () => {
    const { machine, run } = setup();
    machine.transition(run.id, "triage", { reason: "x", patch: { branch: "factory/1-x" } });
    const after = machine.transition(run.id, "needs_human", { reason: "x", patch: { branch: undefined } });
    expect(after.branch).toBe("factory/1-x");
  });

  it("blocks instead of crashing when an output file is missing", () => {
    const { at, move } = setup();
    at("gate");
    expect(() => move("review", fakeEvidence({ files: { checks: undefined } }))).toThrow(/evidence unavailable/);
  });

  it("does not change state when a guard fails", () => {
    const { store, run, at, move } = setup();
    at("build");
    const eventsBefore = store.listEvents(run.id).length;
    expect(() => move("gate", fakeEvidence({ pushed: false }))).toThrow();
    expect(store.getRun(run.id)!.state).toBe("build");
    expect(store.listEvents(run.id)).toHaveLength(eventsBefore);
  });

  it("refuses a move when another writer changed the run after it was read", () => {
    const { store, run, at, move } = setup();
    at("build");
    const evidence = fakeEvidence();
    const original = evidence.git.head;
    // Simulate another process moving the run while this one gathers evidence.
    evidence.git.head = () => {
      store.writeState(run.id, "cancelled");
      return original();
    };
    expect(() => move("gate", evidence)).toThrow(/changed concurrently \(now cancelled\)/);
    expect(store.getRun(run.id)!.state).toBe("cancelled");
  });

  it("respects leases", () => {
    const { store, machine, run } = setup();
    store.acquireLease(run.id, "worker-1", 60_000);

    expect(() => machine.transition(run.id, "triage", { reason: "x" })).toThrow(/leased by worker-1/);
    expect(() => machine.transition(run.id, "triage", { reason: "x", owner: "worker-2" })).toThrow(/leased by worker-1/);
    expect(machine.transition(run.id, "triage", { reason: "x", owner: "worker-1" }).state).toBe("triage");
  });

  it("refuses a worker whose lease expired and releases leases on terminal states", () => {
    const { store, machine, run } = setup();
    store.acquireLease(run.id, "worker-1", -1);
    expect(() => machine.transition(run.id, "triage", { reason: "x", owner: "worker-1" })).toThrow(/does not hold/);

    store.acquireLease(run.id, "worker-2", 60_000);
    const cancelled = machine.transition(run.id, "cancelled", { reason: "x", owner: "worker-2" });
    expect(cancelled.lease_owner).toBeNull();
  });
});

describe("RunMachine.resume", () => {
  function parked(gate: "review" | null = "review") {
    const ctx = setup();
    ctx.at("gate");
    ctx.machine.transition(ctx.run.id, "needs_human", { reason: "gate", patch: { waiting_gate: gate } });
    return ctx;
  }

  it("cannot be bypassed with transition()", () => {
    const { machine, run } = parked();
    expect(() => machine.transition(run.id, "review", { reason: "sneaky" })).toThrow(/only be resumed by a human/);
  });

  it("lets a human approve one stage onward and records the decision", () => {
    const { machine, store, run } = parked();
    const resumed = machine.resume(run.id, "review", { comment: "checks look fine" });

    expect(resumed).toMatchObject({ state: "review", waiting_gate: null, parked_from: null });
    expect(store.listDecisions(run.id)).toMatchObject([
      { gate: "review", mode: "auto", outcome: "approve", actor: "human", comment: "checks look fine" },
    ]);
  });

  it("never lets a human jump over stages", () => {
    const { machine, run } = parked();
    expect(resumeTargets({ parked_from: "gate" })).not.toContain("merge");
    expect(() => machine.resume(run.id, "merge", { comment: "ship it" })).toThrow(/one stage past/);
  });

  it("can send work back with a fresh loop budget", () => {
    const { machine, store, run } = parked();
    store.writeState(run.id, "needs_human", { build_iterations: 4 });
    const resumed = machine.resume(run.id, "build", { comment: "try a different approach", resetLoops: true });
    expect(resumed.build_iterations).toBe(0);
  });

  it("requires a comment and a parked run", () => {
    const { machine, run } = parked();
    expect(() => machine.resume(run.id, "review", { comment: " " })).toThrow(/comment/);

    const other = setup();
    expect(() => other.machine.resume(other.run.id, "triage", { comment: "x" })).toThrow(/not waiting for a human/);
  });

  it("records rejections as escalation decisions when no gate was waiting", () => {
    const { machine, store, run } = parked(null);
    expect(machine.resume(run.id, "rejected", { comment: "not worth it" }).state).toBe("rejected");
    expect(store.listDecisions(run.id)).toMatchObject([{ gate: "escalation", outcome: "reject" }]);
  });
});
