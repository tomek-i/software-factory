import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Store } from "@factory/core";
import { GIT_TEST_TIMEOUT, reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, setup, TRIAGE } from "../../test/runs-setup.js";
import { CliError } from "../context.js";
import { runApprove, runReject, runStatus } from "./runs.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("approve / reject / cancel", () => {
  it("only acts on runs waiting at a gate", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();

    expect(() => runReject(dir, "#12", { message: " " })).toThrow(/Say why/);
    const approved = await runApprove(dir, "#12", { message: "go", run: false });
    expect(approved).toContain("Approved the triage gate");
    expect(approved).toContain("factory run 12");
    expect(runStatus(dir)).toMatch(/\bbuild\b/);
    await expect(runApprove(dir, "#12", {})).rejects.toThrow(/not waiting at a gate \(it is build\)/);
    expect(() => runReject(dir, "#12", { message: "no" })).toThrow(CliError);
  });

  it("keeps driving the run after an approval", async () => {
    const { run, queue, dir, deps, printed } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()], "triage: human");
    queue();
    await run();

    const message = await runApprove(dir, "12", { message: "go" }, deps);

    expect(printed.some((l) => /^Approved the triage gate of run-12-\w+; it moves to build\.$/.test(l))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);
    expect(message).toMatch(/waiting at the review gate/);
    // Approving the review gate has nothing to drive yet.
    expect(await runApprove(dir, "12", {}, deps)).toMatch(/moves to capture\.\nCapture and merge are not automated yet/);
  });

  it("records an approval but does not drive a run whose issue was unqueued", async () => {
    const { run, queue, dir, deps, root, fake } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    const s = new Store(join(root, ".factory", "factory.db"));
    s.setQueued(s.listProjects()[0]!.id, 12, false);
    s.close();

    const message = await runApprove(dir, "12", {}, deps);

    expect(message).toMatch(/moves to build\.\nIssue #12 is no longer queued, so the run was not continued/);
    expect(runStatus(dir)).toMatch(/\bbuild\b/);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage"]);
  });

  it("rejects a waiting run with a reason", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    expect(runReject(dir, "#12", { message: "not now" })).toContain("Rejected");
    expect(runStatus(dir, { all: true })).toMatch(/rejected/);
  });

  it("explains unknown run references", async () => {
    const { dir } = setup([]);
    await expect(runApprove(dir, "run-nope", {})).rejects.toThrow(/No run "run-nope"/);
    await expect(runApprove(dir, "#99", {})).rejects.toThrow(/No run for issue #99/);
  });
});
