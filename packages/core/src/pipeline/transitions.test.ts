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
    gateFingerprint?: string;
  } = {},
): Evidence {
  const files: Record<string, string | undefined> = { ...FILES, ...overrides.files };
  return {
    ...(overrides.gateFingerprint !== undefined ? { gateFingerprint: () => overrides.gateFingerprint! } : {}),
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
  // Like the machine, putting the run in the gate starts a new round.
  const at = (state: RunState, patch: StatePatch = {}) =>
    store.writeState(run.id, state, state === "gate" ? { round: store.getRun(run.id)!.round + 1, ...patch } : patch);
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

  it("can go from an approved triage straight to build", () => {
    // Only when the spec critic gate is set to always; the next test covers the other modes.
    const { at, move } = setup({ gates: { critic: "always" } });
    at("triage");
    expect(() => move("build", fakeEvidence({ files: { triage: FILES.triage.replace("APPROVE", "NEEDS_INFO") } }))).toThrow(
      /did not APPROVE/,
    );
    expect(move("build").state).toBe("build");
  });

  it("does not skip the spec critic unless its gate is always, nor an incomplete issue's refine", () => {
    const incomplete = fakeEvidence({ files: { triage: FILES.triage.replace("READY", "INCOMPLETE") } });
    for (const critic of ["auto", "human"] as const) {
      const { at, move } = setup({ gates: { critic } });
      at("triage");
      expect(() => move("build")).toThrow(new RegExp(`spec critic gate is ${critic}, not always`));
    }
    const { at, move } = setup({ gates: { critic: "always" } });
    at("triage");
    expect(() => move("build", incomplete)).toThrow(/INCOMPLETE/);
    expect(() => move("critic", incomplete)).toThrow(/INCOMPLETE/);
    expect(move("refine", incomplete).state).toBe("refine");
  });

  it("only builds once the spec critic accepted", () => {
    const { at, move } = setup();
    at("critic");
    expect(() => move("build", fakeEvidence({ files: { critic: "VERDICT: REVISE\n" } }))).toThrow(/did not ACCEPT/);
    expect(move("build").state).toBe("build");
  });

  it("does not build on an ACCEPT older than the latest refined spec", () => {
    const { at, move } = setup();
    at("critic");
    const rounds = (critic: number, refine: number): Evidence => ({
      ...fakeEvidence(),
      specRound: (file) => (file === "critic.md" ? critic : refine),
    });
    expect(() => move("build", rounds(1, 2))).toThrow(/accepted spec round 1, but refine has written round 2 since/);
    expect(move("build", rounds(2, 2)).state).toBe("build");
  });

  it("builds without a critic verdict only when the critic gate is set to always", () => {
    const always = setup({ gates: { critic: "always" } });
    always.at("critic");
    expect(always.move("build", fakeEvidence({ files: { critic: undefined } })).state).toBe("build");
    const auto = setup();
    auto.at("critic");
    expect(() => auto.move("build", fakeEvidence({ files: { critic: undefined } }))).toThrow(/evidence unavailable/);
  });

  it("lets the spec critic wait for the issue's author", () => {
    const { at, move } = setup();
    at("critic");
    expect(move("needs_info").state).toBe("needs_info");
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

  it("only marks the PR ready from a clean, pushed branch", () => {
    const { at, move } = setup();
    at("pr");
    expect(() => move("merge", fakeEvidence({ pushed: false }))).toThrow(/not pushed/);
    expect(move("merge").state).toBe("merge");
  });

  it("only leaves the merge stage for learn once GitHub says the run's PR is merged", () => {
    const { at, move } = setup();
    at("merge", { pr_number: 7 });
    const pr = (state: "open" | "merged" | "closed", number = 7) => ({ ...fakeEvidence(), pullRequest: () => ({ number, state, draft: false, head: HEAD }) });
    expect(() => move("learn")).toThrow(/no pull request state/);
    expect(() => move("learn", pr("open"))).toThrow(/PR #7 is open, not merged/);
    expect(() => move("learn", pr("merged", 8))).toThrow(/not the run's PR/);
    expect(move("learn", pr("merged")).state).toBe("learn");
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

  it("starts a new round each time the run enters the gate, and never resets it", () => {
    const { store, machine, run, move } = setup({ loops: { max_build_iterations: 5 } });
    const failed = fakeEvidence({ files: { checks: `GATE: FAIL
COMMIT: ${HEAD}
` } });
    store.writeState(run.id, "build");
    expect(move("gate").round).toBe(1);
    expect(move("build", failed).round).toBe(1);
    expect(move("gate").round).toBe(2);
    move("needs_human");
    // A human sending the run back to the gate starts a round too; a loop reset leaves rounds alone.
    expect(machine.resume(run.id, "gate", { comment: "check again", resetLoops: true })).toMatchObject({ round: 3, build_iterations: 0 });
    move("needs_human");
    expect(machine.resume(run.id, "build", { comment: "fix it" }).round).toBe(3);
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

describe("stall detection", () => {
  const failedGate = (fingerprint: string) =>
    fakeEvidence({ files: { checks: `GATE: FAIL\nCOMMIT: ${HEAD}\n` }, gateFingerprint: fingerprint });
  const confirmed = (findings: object[]) =>
    fakeEvidence({ files: { verify: `VERDICT: CONFIRMED\n\n## Findings\n\`\`\`json\n${JSON.stringify(findings)}\n\`\`\`\n` } });
  const stallOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err as TransitionError;
    }
    throw new Error("expected the move to be refused");
  };

  it("records the failure's fingerprint and round on the loop's event", () => {
    const { store, run, at, move } = setup();
    at("gate");
    move("build", failedGate("A"));
    expect(store.listEvents(run.id).at(-1)!.data).toEqual({ fingerprint: "A", round: 1 });
  });

  it("refuses to loop the gate on the same failure twice in a row, naming both rounds", () => {
    const { at, move } = setup({ loops: { max_build_iterations: 10 } });
    at("gate");
    move("build", failedGate("A"));
    at("gate");
    move("build", failedGate("B"));
    at("gate");
    const err = stallOf(() => move("build", failedGate("B")));

    const reason = "stalled: quality gate failed the same way in rounds 2 and 3 (see round-2/checks.md and round-3/checks.md)";
    expect(err.problems).toEqual([reason]);
    expect(err.stall).toEqual({
      edge: "gate->build",
      fingerprint: "B",
      rounds: [2, 3],
      files: ["round-2/checks.md", "round-3/checks.md"],
      reason,
    });
  });

  it("keeps looping when failures alternate (A, B, A)", () => {
    const { at, move } = setup({ loops: { max_build_iterations: 10 } });
    for (const fp of ["A", "B", "A", "B"]) {
      at("gate");
      expect(move("build", failedGate(fp)).state).toBe("build");
    }
  });

  it("does not compare across another way back to build", () => {
    const { at, move } = setup({ loops: { max_build_iterations: 10 } });
    at("gate");
    move("build", failedGate("A"));
    at("review");
    move("build", confirmed([{ id: "F1", severity: "major", claim: "bug", evidence: "x" }]));
    at("gate");
    expect(move("build", failedGate("A")).state).toBe("build");
  });

  it("names the stall, not the cap, when both apply in the same round", () => {
    const { at, move } = setup({ loops: { max_build_iterations: 2 } });
    at("gate");
    move("build", failedGate("A"));
    at("gate");
    const err = stallOf(() => move("build", failedGate("A")));
    expect(err.stall?.rounds).toEqual([1, 2]);
    expect(err.problems).toEqual([expect.stringMatching(/^stalled: /), "build iteration cap reached (2)"]);
  });

  it("starts a fresh comparison after a human resumes the run, with or without a loop reset", () => {
    for (const resetLoops of [false, true]) {
      const { machine, run, at, move } = setup({ loops: { max_build_iterations: 10 } });
      at("gate");
      move("build", failedGate("A"));
      at("gate");
      expect(stallOf(() => move("build", failedGate("A"))).stall).toBeDefined();
      machine.transition(run.id, "needs_human", { reason: "stalled" });
      machine.resume(run.id, "build", { comment: "try another approach", resetLoops });

      at("gate");
      expect(move("build", failedGate("A")).state).toBe("build");
      at("gate");
      expect(stallOf(() => move("build", failedGate("A"))).stall).toBeDefined();
    }
  });

  it("does not detect stalls without a gate fingerprint", () => {
    const { at, move } = setup({ loops: { max_build_iterations: 10 } });
    const failed = fakeEvidence({ files: { checks: `GATE: FAIL\nCOMMIT: ${HEAD}\n` } });
    at("gate");
    move("build", failed);
    at("gate");
    expect(move("build", failed).state).toBe("build");
  });

  it("refuses to send identical confirmed findings back to the builder twice in a row", () => {
    const { store, run, at, move } = setup({ loops: { max_review_rounds: 10 } });
    const round1 = [
      { id: "F1", severity: "major", file: "src/a.ts", line: 3, claim: "off by one", evidence: "uses <=" },
      { id: "F2", severity: "critical", file: "src/b.ts", claim: "sql injection", evidence: "string concat" },
    ];
    // Same findings with new ids, shifted lines, other evidence and in another order.
    const round2 = [
      { id: "R2-1", severity: "critical", file: "src/b.ts", line: 12, claim: "sql injection", evidence: "still concatenated" },
      { id: "R2-2", severity: "major", file: "src/a.ts", line: 9, claim: "off by one", evidence: "moved" },
      { id: "R2-3", severity: "nit", file: "src/c.ts", claim: "naming", evidence: "x" },
    ];
    at("gate");
    at("review");
    move("build", confirmed(round1));
    at("gate");
    at("review");
    const err = stallOf(() => move("build", confirmed(round2)));

    expect(err.stall).toMatchObject({ edge: "review->build", rounds: [1, 2], files: ["round-1/verify.md", "round-2/verify.md"] });
    expect(err.problems[0]).toBe(
      "stalled: the verifier confirmed the same findings in review rounds 1 and 2 (see round-1/verify.md and round-2/verify.md)",
    );
    expect(store.getRun(run.id)!.review_rounds).toBe(1);
  });

  it("loops review back to the builder when the confirmed findings differ", () => {
    const { at, move } = setup({ loops: { max_review_rounds: 10 } });
    at("review");
    move("build", confirmed([{ id: "F1", severity: "major", file: "src/a.ts", claim: "off by one", evidence: "x" }]));
    at("review");
    const next = move("build", confirmed([{ id: "F1", severity: "major", file: "src/a.ts", claim: "missing test", evidence: "x" }]));
    expect(next.review_rounds).toBe(2);
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
    expect(() => machine.resume(run.id, "merge", { comment: "ship it" })).toThrow(/one step onward/);
  });

  it("lets a human approve triage straight into build while there is no spec critic", () => {
    expect(resumeTargets({ parked_from: "triage" })).toEqual(expect.arrayContaining(["intake", "triage", "build", "critic"]));
    expect(resumeTargets({ parked_from: "triage" })).not.toContain("gate");
  });

  it("records the commit a human approved on the resume event", () => {
    const { machine, store, run, at } = setup();
    at("merge");
    machine.transition(run.id, "needs_human", { reason: "merge gate", patch: { waiting_gate: "merge" } });
    machine.resume(run.id, "merge", { comment: "ship it", commitSha: HEAD });
    expect(store.listEvents(run.id).at(-1)!.data).toEqual({ gate: "merge", resetLoops: false, commit: HEAD });
    expect(store.listDecisions(run.id).at(-1)).toMatchObject({ gate: "merge", commit_sha: HEAD });
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

describe("RunMachine.cancel", () => {
  it("stops an active run even while another worker holds its lease", () => {
    const { machine, store, run, at } = setup();
    at("build");
    expect(store.acquireLease(run.id, "worker-1", 60_000)).toBe(true);

    const cancelled = machine.cancel(run.id, "wrong approach");

    expect(cancelled).toMatchObject({ state: "cancelled", lease_owner: null });
    expect(store.listDecisions(run.id)).toMatchObject([{ gate: "escalation", outcome: "reject", actor: "human" }]);
    expect(store.listEvents(run.id).at(-1)).toMatchObject({ from_state: "build", to_state: "cancelled" });
    expect(() => machine.transition(run.id, "gate", { reason: "late", owner: "worker-1" })).toThrow(TransitionError);
  });

  it("needs a comment and an unfinished run", () => {
    const { machine, run, at } = setup();
    expect(() => machine.cancel(run.id, "")).toThrow(/comment/);
    at("done");
    expect(() => machine.cancel(run.id, "x")).toThrow(/already done/);
  });
});

describe("RunMachine.closeByPullRequest", () => {
  const MERGE = "c".repeat(40);

  it("finishes a run parked at a gate whose PR was merged, recording a human merge decision", () => {
    const { machine, store, run, at } = setup();
    at("needs_human", { pr_number: 7, waiting_gate: "review", parked_from: "review" });

    const done = machine.closeByPullRequest(run.id, { number: 7, state: "merged", mergeCommit: MERGE });

    expect(done).toMatchObject({ state: "done", waiting_gate: null, parked_from: null });
    expect(store.listDecisions(run.id)).toMatchObject([
      { gate: "merge", outcome: "approve", actor: "human", comment: "merged PR #7 on GitHub", commit_sha: MERGE },
    ]);
    expect(store.listEvents(run.id).at(-1)).toMatchObject({ from_state: "needs_human", to_state: "done", data: { pr: 7, mergeCommit: MERGE } });
  });

  it("cancels a run whose PR was closed without merging", () => {
    const { machine, store, run, at } = setup();
    at("review", { pr_number: 7 });
    expect(machine.closeByPullRequest(run.id, { number: 7, state: "closed" }).state).toBe("cancelled");
    expect(store.listEvents(run.id).at(-1)!.reason).toBe("PR #7 was closed on GitHub without merging");
    expect(store.listDecisions(run.id)).toMatchObject([{ outcome: "reject", commit_sha: null }]);
  });

  it("refuses without evidence that the run's own PR is finished", () => {
    const { machine, store, run, at } = setup();
    at("needs_human", { pr_number: 7, waiting_gate: "review" });
    expect(() => machine.closeByPullRequest(run.id, { number: 7, state: "open" })).toThrow(/still open/);
    expect(() => machine.closeByPullRequest(run.id, { number: 8, state: "merged", mergeCommit: MERGE })).toThrow(/not the run's PR/);
    expect(() => machine.closeByPullRequest(run.id, { number: 7, state: "merged" })).toThrow(/no merge commit/);
    expect(store.getRun(run.id)!.state).toBe("needs_human");

    at("cancelled");
    expect(() => machine.closeByPullRequest(run.id, { number: 7, state: "merged", mergeCommit: MERGE })).toThrow(/already cancelled/);
  });

  it("refuses a run without a PR, and a run another worker is driving", () => {
    const { machine, store, run, at } = setup();
    at("build");
    expect(() => machine.closeByPullRequest(run.id, { number: 7, state: "closed" })).toThrow(/no pull request/);
    at("merge", { pr_number: 7 });
    store.acquireLease(run.id, "worker-1", 60_000);
    expect(() => machine.closeByPullRequest(run.id, { number: 7, state: "merged", mergeCommit: MERGE })).toThrow(/leased by worker-1/);
    expect(machine.closeByPullRequest(run.id, { number: 7, state: "merged", mergeCommit: MERGE }, "worker-1").state).toBe("done");
  });
});
