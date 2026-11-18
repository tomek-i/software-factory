import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runCommand, RunMachine, Store, type CommandRunner } from "@factory/core";
import { factoryConfigSchema } from "@factory/shared";
import { reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, github, prStates, setup, TRIAGE } from "../../test/runs-setup.js";
import { runCleanup } from "./cleanup.js";
import { runSync } from "./issues.js";

/** git for real; `gh issue list` finds no open issues. */
const noIssues: CommandRunner = (cmd, args, opts) => (cmd === "gh" ? { code: 0, stdout: "[]", stderr: "" } : runCommand(cmd, args, opts));

describe("factory cleanup", () => {
  it("lists the leftovers of finished runs with --dry-run, then removes them", async () => {
    const { run, queue, dir, root } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    const [id] = readdirSync(join(root, ".factory", "runs")) as [string];
    const worktree = join(root, ".worktrees", id);
    // A run that finished before cleanup existed: cancelled directly in the store, its worktree left behind.
    const store = new Store(join(root, ".factory", "factory.db"));
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(id, "old run");
    store.close();
    // Past the grace that leaves runs that just finished to their worker.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    onTestFinished(() => void vi.useRealTimers());

    const dry = runCleanup(dir, { dryRun: true });
    expect(dry.startsWith(`${id}: would remove worktree, local branch factory/12-`)).toBe(true);
    expect(dry).toMatch(/: would remove worktree, local branch factory\/12-[\w-]+\n\nNothing was removed \(--dry-run\)\.$/);
    expect(existsSync(worktree)).toBe(true);
    expect(runCleanup(dir)).toMatch(new RegExp(`^${id}: removed worktree, local branch factory/12-`));
    expect(existsSync(worktree)).toBe(false);
    expect(runCleanup(dir)).toBe("Nothing to clean up.");
  });

  it("lists a run that just finished as left alone, and cleans it up with --now", async () => {
    const { run, queue, dir, root } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run();
    const [id] = readdirSync(join(root, ".factory", "runs")) as [string];
    const worktree = join(root, ".worktrees", id);
    const store = new Store(join(root, ".factory", "factory.db"));
    new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).cancel(id, "not needed");
    store.close();

    const left = runCleanup(dir);
    expect(left).toMatch(/^Left alone:\n {2}\S+: finished \d+s ago; cleaned up 2 minutes after it finished\n`factory cleanup --now` cleans up the runs that just finished\.$/);
    expect(left).toContain(`  ${id}: finished`);
    expect(existsSync(worktree)).toBe(true);
    expect(runCleanup(dir, { now: true, dryRun: true })).toMatch(/would remove worktree[\s\S]*Nothing was removed \(--dry-run\)\.$/);
    expect(runCleanup(dir, { now: true })).toMatch(new RegExp(`^${id}: removed worktree, local branch factory/12-`));
    expect(existsSync(worktree)).toBe(false);
  });

  it("cleans up a run merged by hand on GitHub as soon as factory sync finishes it", async () => {
    const { run, queue, dir, root } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();
    await run(); // waits at the review gate, its branch pushed and PR #7 open
    const [id] = readdirSync(join(root, ".factory", "runs")) as [string];
    const worktree = join(root, ".worktrees", id);
    const head = runCommand("git", ["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
    prStates.set(7, { number: 7, state: "merged", draft: false, head, mergeCommit: "e".repeat(40) });

    const synced = runSync(dir, noIssues, github);

    expect(synced).toContain(`${id}: PR #7 merged -> done`);
    expect(synced).toContain(`${id}: removed worktree, local branch factory/12-`);
    expect(existsSync(worktree)).toBe(false);
  });
});
