import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT } from "../../test/helpers.js";
import { createAgentRunner } from "../agents/runner.js";
import { loadTrustedConfig, trustedReader } from "../config/trusted.js";
import { PipelineDriver } from "../pipeline/driver.js";
import { RunMachine } from "../pipeline/transitions.js";
import { appendLessons, lessonsBranch, lessonsPrBody, publishLessons, type ApprovedLesson } from "./publish.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const lesson = (id: number, rule: string): ApprovedLesson => ({
  id,
  run_id: "run-12-abcd1234",
  issue_number: 12,
  rule,
  observation: "The gate failed\non lint twice.",
  evidence: "round-1/checks.md, round-2/checks.md",
});

describe("appendLessons", () => {
  it("adds each rule as a list item after the intro, keeping the file's line endings", () => {
    const intro = "# Lessons\n\nApproved lessons from past runs.\n";
    expect(appendLessons(intro, ["Run lint first."])).toBe("# Lessons\n\nApproved lessons from past runs.\n\n- Run lint first.\n");
    expect(appendLessons("# Lessons\n\n- Run lint first.\n\n", ["Use pnpm.", " Keep tests next to the code. "])).toBe(
      "# Lessons\n\n- Run lint first.\n- Use pnpm.\n- Keep tests next to the code.\n",
    );
    expect(appendLessons("# Lessons\r\n\r\n- Run lint first.\r\n", ["Use pnpm."])).toBe("# Lessons\r\n\r\n- Run lint first.\r\n- Use pnpm.\r\n");
    expect(appendLessons(undefined, ["Use pnpm."])).toMatch(/^# Lessons\n\n.*\n\n- Use pnpm\.\n$/);
  });

  it("names the branch after the UTC time and lists each lesson with its run in the PR", () => {
    expect(lessonsBranch(new Date("2026-11-12T09:05:07.123Z"))).toBe("factory/lessons-20261112-090507");
    const body = lessonsPrBody([lesson(3, "Run lint first."), lesson(4, "Use pnpm.")], "main");
    expect(body).toContain("Adds 2 lessons approved with `factory lessons approve` to `.factory/lessons.md`.");
    expect(body).toContain("- **Run lint first.**\n  From run `run-12-abcd1234` (#12), lesson 3: The gate failed on lint twice.\n  Evidence: round-1/checks.md, round-2/checks.md");
    expect(body).toContain("- **Use pnpm.**");
  });
});

describe("publishLessons", () => {
  it("opens a ready PR that appends the rules, from a temporary worktree, without touching main", () => {
    const { root, github, readyPrs } = setup([]);
    const mainBefore = git(root, "rev-parse", "origin/main");

    const published = publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, "Run lint first."), lesson(4, "Use pnpm.")], github, now: new Date("2026-11-12T09:05:07Z") });

    expect(published).toEqual({ branch: "factory/lessons-20261112-090507", number: 8 });
    expect(readyPrs).toEqual([{ head: published.branch, base: "main", title: "chore(factory): add 2 approved lessons", body: expect.stringContaining("- **Use pnpm.**") }]);
    git(root, "fetch", "-q", "origin");
    expect(git(root, "show", `origin/${published.branch}:.factory/lessons.md`)).toMatch(/^# Lessons\n\n.*\n\n- Run lint first\.\n- Use pnpm\.$/);
    expect(git(root, "rev-parse", `origin/${published.branch}^`)).toBe(mainBefore);
    expect(git(root, "rev-parse", "origin/main")).toBe(mainBefore);
    // The temporary worktree is gone, no local branch was made, and the working copy is untouched.
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(root, "branch", "--list", "factory/*")).toBe("");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("removes the temporary worktree and opens no PR when the push fails", () => {
    const { root, github, readyPrs } = setup([]);
    git(root, "remote", "set-url", "--push", "origin", join(root, "no-such-remote.git"));

    expect(() => publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, "Run lint first.")], github })).toThrow(/git push failed/);
    expect(readyPrs).toEqual([]);
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("puts an approved lesson in later agents' prompts once its PR is merged, and not before", async () => {
    const config = "version: 1\ntrust:\n  authors: [alice]\ngates:\n  triage: human\n";
    const { root, store, project, driver, fake, github } = setup([{ output: TRIAGE() }, { output: TRIAGE() }], { config });
    const rule = "Run `node check.js` before handing over.";
    const { branch } = publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, rule)], github });

    // While the PR is open, agents do not see the lesson.
    const first = driver.startRun(12);
    await driver.drive(first.id);
    expect(fake.calls()[0]!.stdin).not.toContain(rule);
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(first.id, "start over");

    // GitHub merges the PR (a fast-forward of main to the lessons branch, on the remote only).
    const remote = git(root, "remote", "get-url", "origin");
    git(remote, "update-ref", "refs/heads/main", `refs/heads/${branch}`);

    // A later `factory run` reads the default branch afresh.
    const read = trustedReader(root, "main");
    const later = new PipelineDriver({ store, project, config: loadTrustedConfig(read, "main"), read, runAgent: createAgentRunner({ store, env: fake.env }), github, owner: "test-worker" });
    const second = later.startRun(12);
    await later.drive(second.id);
    expect(fake.calls()[1]!.stdin).toContain(`## Lessons from earlier runs\n# Lessons\n\nApproved lessons from past runs. Agents read this file before they start.\n\n- ${rule}`);
  });
});
