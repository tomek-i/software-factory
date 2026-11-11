import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findRepoRoot } from "@factory/core";
import { git, GIT_TEST_TIMEOUT, reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, github, setup, TRIAGE } from "../../test/runs-setup.js";
import { runApprove, runCancel, runResume, runStatus } from "./runs.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("approve / reject / cancel", () => {
  it("cancels a run and keeps its worktree", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    const worktrees = join(findRepoRoot(dir)!, ".worktrees");

    const message = runCancel(dir, "run-12", {});

    expect(message).toMatch(/^Cancelled run-12-\w+\./);
    expect(message).toContain("The worktree is kept");
    expect(existsSync(worktrees)).toBe(true);
    expect(git(dir, "worktree", "list")).toContain(".worktrees");
    expect(() => runCancel(dir, "#12", {})).toThrow(/already cancelled/);
    expect(runStatus(dir, {}, { github })).toContain("No active runs");
  });

  it("resumes an escalated run to a stage it may go back to", async () => {
    const blocked = { output: "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nPricing decision needed.\n" };
    const { run, queue, dir } = setup([{ output: TRIAGE }, blocked]);
    queue();
    expect(await run()).toMatch(/needs you: builder is blocked[\s\S]*factory resume/);

    await expect(runApprove(dir, "#12", {})).rejects.toThrow(/not waiting at a gate/);
    await expect(runResume(dir, "#12", { to: "merge", message: "ship" })).rejects.toThrow(/can resume to: .*build/);
    expect(await runResume(dir, "#12", { to: "build", message: "use the flat price", resetLoops: true, run: false })).toBe(
      "Resumed " + runStatus(dir, {}, { github }).split("\n")[1]!.split(/\s+/)[0] + " to build with a fresh loop budget.\nContinue with `factory run 12`.",
    );
    expect(runStatus(dir, {}, { github })).toMatch(/\bbuild\b/);
  });

  it("triages again when the issue was waiting for its author", async () => {
    const needsInfo = { output: TRIAGE.replace("APPROVE", "NEEDS_INFO") + "\n## Questions\n- Which format?\n" };
    const { run, queue, printed } = setup([needsInfo, { output: TRIAGE }], "triage: human");
    queue();
    expect(await run()).toMatch(/waiting for answers on issue #12/);

    expect(await run()).toMatch(/waiting at the triage gate[\s\S]*See it with: `factory show run-12-\w+ triage`/);
    expect(printed).toContain("-> triage: triage again with the current issue text");
  });

  it("keeps driving the run after a resume", async () => {
    const blocked = { output: "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nPricing decision needed.\n" };
    const { run, queue, dir, deps } = setup([{ output: TRIAGE }, blocked, BUILD, ...reviewsPass()]);
    queue();
    await run();

    expect(await runResume(dir, "12", { to: "build", message: "use the flat price" }, deps)).toMatch(/waiting at the review gate/);
  });
});
