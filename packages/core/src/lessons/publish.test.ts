import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { setup, TRIAGE } from "../../test/driver-setup.js";
import { git, GIT_TEST_TIMEOUT } from "../../test/helpers.js";
import { createAgentRunner } from "../agents/runner.js";
import type { GithubPort } from "../github/port.js";
import { runCommand, type CommandRunner } from "../util/exec.js";
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
    expect(lessonsBranch(new Date("2026-11-12T09:05:07.123Z"))).toBe("factory/lessons-20261112-090507-123");
    expect(lessonsBranch(new Date("2026-11-12T09:05:07.124Z"))).not.toBe(lessonsBranch(new Date("2026-11-12T09:05:07.123Z")));
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

    expect(published).toEqual({ branch: "factory/lessons-20261112-090507-000", number: 8, addedToOpen: false });
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

  it("adds to a lessons PR that is still open instead of opening a second one that would conflict", () => {
    const { root, github, readyPrs, edits } = setup([]);
    const first = publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, "Run lint first.")], github });

    const second = publishLessons({
      root,
      defaultBranch: "main",
      lessons: [lesson(4, "Use pnpm.")],
      github,
      inPullRequest: (number) => (number === 8 ? [lesson(3, "Run lint first.")] : []),
    });

    expect(second).toEqual({ branch: first.branch, number: 8, addedToOpen: true });
    expect(readyPrs).toHaveLength(1);
    git(root, "fetch", "-q", "origin");
    expect(git(root, "show", `origin/${first.branch}:.factory/lessons.md`)).toMatch(/\n- Run lint first\.\n- Use pnpm\.$/);
    expect(git(root, "rev-list", "--count", `origin/main..origin/${first.branch}`)).toBe("2");
    expect(edits).toEqual([{ number: 8, body: expect.stringContaining("Adds 2 lessons") }]);
    expect(edits[0]!.body).toContain("- **Run lint first.**");
    expect(edits[0]!.body).toContain("- **Use pnpm.**");
  });

  it("opens a new PR once the earlier lessons PR is closed or merged", () => {
    const { root, github, readyPrs, closedReady } = setup([]);
    publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, "Run lint first.")], github, now: new Date("2026-11-12T09:05:07.001Z") });
    closedReady.add(8);
    const next = publishLessons({ root, defaultBranch: "main", lessons: [lesson(4, "Use pnpm.")], github, now: new Date("2026-11-12T09:05:07.002Z") });
    expect(next).toMatchObject({ number: 9, addedToOpen: false, branch: "factory/lessons-20261112-090507-002" });
    expect(readyPrs).toHaveLength(2);
  });

  it("keeps the repository's commit hooks, and says a hook refused when one does; nothing is pushed", () => {
    const { root, github, readyPrs } = setup([]);
    const hooks = join(root, "..", "hooks");
    mkdirSync(hooks);
    // Like husky in a fresh worktree without node_modules.
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'husky: command not found' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    git(root, "config", "core.hooksPath", hooks);

    expect(() => publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, "Run lint first.")], github })).toThrow(
      /a commit hook or commit signing in this repository refused the lessons commit \(they are never skipped\), so nothing was pushed: git commit failed: husky: command not found/,
    );
    expect(readyPrs).toEqual([]);
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/*")).toBe("");
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("cleans up its temporary folder when the worktree cannot be added", () => {
    const { root, github, readyPrs } = setup([]);
    let tempWorktree = "";
    const run: CommandRunner = (cmd, args, options) => {
      if (args[0] === "worktree" && args[1] === "add") {
        tempWorktree = args[4]!;
        return { code: 128, stdout: "", stderr: "fatal: cannot lock ref" };
      }
      return runCommand(cmd, args, options);
    };

    expect(() => publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, "Run lint first.")], github, run })).toThrow(/git worktree failed: fatal: cannot lock ref/);
    expect(tempWorktree).not.toBe("");
    expect(existsSync(dirname(tempWorktree))).toBe(false);
    expect(readyPrs).toEqual([]);
  });

  it("deletes the pushed branch when the PR cannot be opened", () => {
    const { root, github } = setup([]);
    const offline: GithubPort = {
      ...github,
      createPullRequest: () => {
        throw new Error("gh: not logged in");
      },
    };

    expect(() => publishLessons({ root, defaultBranch: "main", lessons: [lesson(3, "Run lint first.")], github: offline })).toThrow(/gh: not logged in/);
    expect(git(root, "ls-remote", "origin", "refs/heads/factory/*")).toBe("");
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
