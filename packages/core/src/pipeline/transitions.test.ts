import { describe, expect, it } from "vitest";
import { factoryConfigSchema, parseVerdict, type RunState } from "@factory/shared";
import { Store } from "../store/store.js";
import { allowedTargets, RunMachine, TransitionError, type Evidence } from "./transitions.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function fakeEvidence(overrides: {
  files?: Partial<Record<string, string>>;
  head?: string;
  clean?: boolean;
  ahead?: number;
  pushed?: boolean;
} = {}): Evidence {
  const files: Record<string, string> = {
    build: "STATUS: READY\n",
    checks: `GATE: PASS\nCOMMIT: ${HEAD}\n`,
    ...overrides.files,
  };
  return {
    verdict: (kind) => {
      const text = files[kind];
      if (text === undefined) throw new Error(`${kind} output missing`);
      return parseVerdict(kind, text);
    },
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
  const at = (state: RunState) => store.writeState(run.id, state);
  return { store, machine, run, at };
}

describe("allowedTargets", () => {
  it("lets every active state escalate, fail or be cancelled", () => {
    expect(allowedTargets("build")).toEqual(expect.arrayContaining(["needs_human", "failed", "cancelled"]));
  });

  it("allows nothing out of terminal states", () => {
    expect(allowedTargets("done")).toEqual([]);
    expect(allowedTargets("rejected")).toEqual([]);
  });
});

describe("RunMachine", () => {
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

  it("only lets the builder hand over a clean, committed, pushed branch", () => {
    const { machine, run, at } = setup();
    at("build");
    const bad = fakeEvidence({ files: { build: "STATUS: BLOCKED\n" }, clean: false, ahead: 0, pushed: false });

    try {
      machine.transition(run.id, "gate", { reason: "built", evidence: bad });
      expect.unreachable();
    } catch (err) {
      expect((err as TransitionError).problems).toHaveLength(4);
    }

    expect(machine.transition(run.id, "gate", { reason: "built", evidence: fakeEvidence() }).state).toBe("gate");
  });

  it("refuses to review a commit the gate did not check", () => {
    const { machine, run, at } = setup();
    at("gate");
    expect(() =>
      machine.transition(run.id, "review", { reason: "gate passed", evidence: fakeEvidence({ head: OLD }) }),
    ).toThrow(/HEAD is bbbbbbb/);
  });

  it("refuses to move past review if new commits landed after the gate", () => {
    const { machine, run, at } = setup();
    at("review");
    expect(() =>
      machine.transition(run.id, "capture", { reason: "reviews clean", evidence: fakeEvidence({ head: OLD }) }),
    ).toThrow(TransitionError);
  });

  it("counts gate failures and stops looping at the cap", () => {
    const { machine, store, run, at } = setup({ loops: { max_build_iterations: 2 } });
    const failed = fakeEvidence({ files: { checks: `GATE: FAIL\nCOMMIT: ${HEAD}\n` } });

    for (let i = 1; i <= 2; i++) {
      at("gate");
      expect(machine.transition(run.id, "build", { reason: "gate failed", evidence: failed }).build_iterations).toBe(i);
    }
    at("gate");
    expect(() => machine.transition(run.id, "build", { reason: "gate failed", evidence: failed })).toThrow(/cap reached/);
    expect(machine.transition(run.id, "needs_human", { reason: "cap reached" }).state).toBe("needs_human");
    expect(store.getRun(run.id)!.build_iterations).toBe(2);
  });

  it("counts review rounds and critic rounds against their caps", () => {
    const { machine, run, at } = setup({ loops: { max_review_rounds: 1, max_critic_rounds: 1 } });
    at("review");
    expect(machine.transition(run.id, "build", { reason: "changes", evidence: fakeEvidence() }).review_rounds).toBe(1);
    at("review");
    expect(() => machine.transition(run.id, "build", { reason: "changes", evidence: fakeEvidence() })).toThrow(/review round cap/);

    at("critic");
    expect(machine.transition(run.id, "refine", { reason: "revise", evidence: fakeEvidence() }).critic_rounds).toBe(1);
    at("critic");
    expect(() => machine.transition(run.id, "refine", { reason: "revise", evidence: fakeEvidence() })).toThrow(/critic round cap/);
  });

  it("blocks instead of crashing when an output file is missing", () => {
    const { machine, run, at } = setup();
    at("gate");
    const missing = fakeEvidence({ files: { checks: undefined } });
    expect(() => machine.transition(run.id, "review", { reason: "x", evidence: missing })).toThrow(/evidence unavailable/);
  });

  it("lets a human resume a parked run into any stage and clears the waiting gate", () => {
    const { machine, store, run, at } = setup();
    at("needs_human");
    store.writeState(run.id, "needs_human", { waiting_gate: "merge" });

    const resumed = machine.transition(run.id, "merge", { reason: "human approved" });
    expect(resumed.state).toBe("merge");
    expect(resumed.waiting_gate).toBeNull();
  });

  it("does not change state when a guard fails", () => {
    const { machine, store, run, at } = setup();
    at("build");
    const eventsBefore = store.listEvents(run.id).length;
    expect(() => machine.transition(run.id, "gate", { reason: "x", evidence: fakeEvidence({ pushed: false }) })).toThrow();
    expect(store.getRun(run.id)!.state).toBe("build");
    expect(store.listEvents(run.id)).toHaveLength(eventsBefore);
  });
});
