import { parseVerdict, type GateMode } from "@factory/shared";
import { describe, expect, it, vi } from "vitest";
import { learned, LESSON } from "../../../test/driver-setup.js";
import { stageSetup } from "../../../test/stage-setup.js";
import type { AgentRunResult } from "../../agents/runner.js";
import type { TurnResult } from "../../agents/turn.js";
import type { Run } from "../../store/store.js";
import { learn } from "./learn.js";

/**
 * The learn stage with the learner's turn handed in. The run's history is written with the same
 * calls the pipeline makes (waitForHuman, RunMachine.resume), so it has the shapes a real run
 * leaves. Driving a whole run to learn is covered by driver.learn*.int.test.ts.
 */
function learning(options: { merge?: GateMode; round?: number } = {}) {
  const { store, ctx, run, at, lastMove } = stageSetup({ gates: { merge: options.merge ?? "always" } });
  /** The run stops at `gate` with `reasons` (as the pipeline's gates do), and a human sends it on to `to`. */
  const humanAt = (from: Run["state"], gate: "review" | "merge", reasons: string[], to: Run["state"], comment: string) => {
    ctx.waitForHuman(at(from, options.round), gate, reasons);
    // The driver lets go of a parked run; the human's resume comes from outside it.
    store.releaseLease(run.id, "test");
    ctx.machine.resume(run.id, to, { comment });
    store.acquireLease(run.id, "test", 60_000);
  };
  const toLearn = () => at("learn", options.round);
  return { store, ctx, run, humanAt, toLearn, lastMove };
}

const agent: AgentRunResult = { agentRunId: "a1", sessionId: "s1", outcome: { kind: "ok" }, exitCode: 0, logPath: "x.jsonl", resultText: "" };
const ok = (body: string): TurnResult<"learn"> => ({ status: "ok", verdict: parseVerdict("learn", body), agent });

describe("learn stage: what is worth the learner's time", () => {
  it("skips the learner for a run that went through in one clean round", async () => {
    const { ctx, toLearn, lastMove, store, run } = learning();
    const learner = vi.fn();

    await learn(ctx, toLearn(), learner);

    expect(learner).not.toHaveBeenCalled();
    expect(lastMove()).toMatchObject({ from_state: "learn", to_state: "done", reason: "nothing to learn: one round, no failed checks or blocking findings, no human stepped in" });
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

  it("does not count a human approving a gate as something to learn from", async () => {
    const { ctx, humanAt, toLearn, lastMove } = learning({ merge: "human" });
    humanAt("review", "review", ["gate is set to human"], "capture", "looks right");
    humanAt("merge", "merge", ["gate is set to human"], "merge", "ship it");
    const learner = vi.fn();

    await learn(ctx, toLearn(), learner);

    expect(learner).not.toHaveBeenCalled();
    expect(lastMove().reason).toMatch(/^nothing to learn/);
  });

  it("learns from a run the approver escalated, even though a human then approved it", async () => {
    const { ctx, humanAt, toLearn } = learning({ merge: "auto" });
    humanAt("merge", "merge", ["the issue leaves the price open"], "merge", "price is fine");
    const learner = vi.fn(async (_run: Run, _worth: string[]) => ok(learned([])));

    await learn(ctx, toLearn(), learner);

    expect(learner.mock.calls[0]![1]).toEqual(["the approver escalated: the issue leaves the price open"]);
  });

  it("learns from a run a hard rule stopped, even though a human then approved it", async () => {
    const { ctx, humanAt, toLearn } = learning();
    humanAt("review", "review", ["hard rule: protected path (infra/**): infra/main.tf"], "capture", "infra change is intended");
    const learner = vi.fn(async (_run: Run, _worth: string[]) => ok(learned([])));

    await learn(ctx, toLearn(), learner);

    expect(learner.mock.calls[0]![1]).toEqual(["stopped by a hard rule: protected path (infra/**): infra/main.tf"]);
  });
});

/** The PR is merged by the time a run learns, so nothing that goes wrong here may hold the run up. */
describe("learn stage: when the learner does not deliver", () => {
  const bumpy = () => learning({ round: 2 });

  it("finishes the run when the learner proposes nothing", async () => {
    const { ctx, toLearn, lastMove, store, run } = bumpy();
    await learn(ctx, toLearn(), async () => ok(learned([])));

    expect(lastMove()).toMatchObject({ to_state: "done", reason: "the learner proposed no lessons", data: { lessons: 0 } });
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

  it("stores the lessons as proposals", async () => {
    const { ctx, toLearn, lastMove, store, run } = bumpy();
    await learn(ctx, toLearn(), async () => ok(learned([LESSON])));

    expect(lastMove()).toMatchObject({ from_state: "learn", to_state: "done", reason: "1 lesson proposed; see `factory lessons`", data: { lessons: 1 } });
    expect(store.listLessons({ project_id: run.project_id })).toMatchObject([{ run_id: run.id, status: "proposed", ...LESSON }]);
  });

  it("finishes the run without lessons when the usage limit is hit", async () => {
    const { ctx, toLearn, lastMove } = bumpy();
    const limited: TurnResult<"learn"> = { status: "failed", agent: { ...agent, outcome: { kind: "rate_limited", resetsAt: "2026-11-18T20:00:00Z" } } };

    // Not rate_limited: the merge is done, and there is nothing to continue after the reset.
    expect(await learn(ctx, toLearn(), async () => limited)).toBeUndefined();
    expect(lastMove()).toMatchObject({ to_state: "done", reason: "lessons skipped: usage limit reached (resets at 2026-11-18T20:00:00Z)" });
  });

  it("finishes the run without lessons when the learner's output is malformed twice", async () => {
    const { ctx, toLearn, lastMove, store, run } = bumpy();
    const malformed: TurnResult<"learn"> = { status: "invalid", problems: ["## Lessons must contain a ```json array block"], agent };

    await learn(ctx, toLearn(), async () => malformed);

    expect(lastMove()).toMatchObject({ to_state: "done", reason: "lessons skipped: learner output was rejected twice: ## Lessons must contain a ```json array block" });
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

  it("finishes the run without lessons when they cannot be stored", async () => {
    const { ctx, toLearn, lastMove, store, run } = bumpy();
    vi.spyOn(store, "addLessons").mockImplementation(() => {
      throw new Error("disk full");
    });

    await learn(ctx, toLearn(), async () => ok(learned([LESSON])));

    expect(lastMove()).toMatchObject({ from_state: "learn", to_state: "done", reason: "lessons skipped: could not store lessons: disk full" });
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });

  it("finishes the run without lessons when the learner cannot be started", async () => {
    const { ctx, toLearn, lastMove } = bumpy();
    await learn(ctx, toLearn(), async () => {
      throw new Error("no prompt");
    });

    expect(lastMove()).toMatchObject({ from_state: "learn", to_state: "done", reason: "lessons skipped: the learner could not start: no prompt" });
  });

  it("stores nothing when the run was cancelled while the learner ran", async () => {
    const { ctx, toLearn, store, run } = bumpy();
    const learning = toLearn();
    await learn(ctx, learning, async () => {
      ctx.machine.cancel(run.id, "stop");
      return ok(learned([LESSON]));
    });

    expect(store.getRun(run.id)!.state).toBe("cancelled");
    expect(store.listLessons({ project_id: run.project_id })).toEqual([]);
  });
});
