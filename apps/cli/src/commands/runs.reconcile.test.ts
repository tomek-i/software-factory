import { describe, expect, it, vi } from "vitest";
import type { GithubPort } from "@factory/core";
import { GIT_TEST_TIMEOUT, reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, github, prStates, setup, TRIAGE } from "../../test/runs-setup.js";
import { runStatus } from "./runs.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("runs whose PR was merged or closed on GitHub", () => {
  it("finishes a run whose PR was merged on GitHub when you look at the status", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    prStates.set(7, { number: 7, state: "merged", draft: false, head: "h", mergeCommit: "c".repeat(40) });

    expect(runStatus(dir, {}, { github })).toMatch(/^12-[\w-]+: PR #7 merged -> done\n12-[\w-]+: removed worktree, local branch factory\/12-[\w-]+, remote branch factory\/12-[\w-]+\n\nNo active runs/);
    expect(runStatus(dir, { all: true }, { github })).toMatch(/^RUN.*\n.*#12\s+done/);
  });

  it("warns but still shows the status when GitHub cannot be asked", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    const offline: GithubPort = {
      ...github,
      pullRequestState: () => {
        throw new Error("gh: not logged in");
      },
    };

    const status = runStatus(dir, {}, { github: offline });
    expect(status).toMatch(/^warning: could not check PR #7 of 12-[\w-]+: gh: not logged in\n\nRUN/);
    expect(status).toMatch(/needs_human/);
  });

  it("finishes a run whose PR was closed before running its issue again", async () => {
    const needsInfo = { output: TRIAGE.replace("APPROVE", "NEEDS_INFO") + "\n## Questions\n- Which format?\n" };
    const { run, queue, printed } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass(), needsInfo]);
    queue();
    await run();
    prStates.set(7, { number: 7, state: "closed", draft: true, head: "h" });

    // The old run is cancelled first, so `factory run` starts a new one instead of continuing it.
    expect(await run()).toMatch(/waiting for answers on issue #12/);
    expect(printed.some((l) => /^12-[\w-]+: PR #7 closed -> cancelled$/.test(l))).toBe(true);
  });
});
