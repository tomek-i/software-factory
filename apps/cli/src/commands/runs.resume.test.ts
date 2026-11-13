import { describe, expect, it, vi } from "vitest";
import { git, GIT_TEST_TIMEOUT, reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, github, setup, TRIAGE } from "../../test/runs-setup.js";
import { runApprove, runCancel, runResume, runStatus } from "./runs.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("approve / reject / cancel", () => {
  it("cancels a run and removes its worktree and local branch; the pushed branch stays for the PR", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    const branch = git(dir, "branch", "--list", "factory/12-*", "--format=%(refname:short)");

    const message = runCancel(dir, "12-", {});

    expect(message).toMatch(new RegExp(`^Cancelled 12-[\\w-]+\\.\\n12-[\\w-]+: removed worktree, local branch ${branch}$`));
    expect(git(dir, "worktree", "list")).not.toContain(".worktrees");
    expect(git(dir, "branch", "--list", branch)).toBe("");
    expect(git(dir, "ls-remote", "origin", `refs/heads/${branch}`)).not.toBe("");
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

    expect(await run()).toMatch(/waiting at the triage gate[\s\S]*See it with: `factory show 12-[\w-]+ triage`/);
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
