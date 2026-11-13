import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunMachine, Store } from "@factory/core";
import { factoryConfigSchema } from "@factory/shared";
import { GIT_TEST_TIMEOUT, reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, setup, TRIAGE } from "../../test/runs-setup.js";
import { runCleanup } from "./cleanup.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

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

    const dry = runCleanup(dir, { dryRun: true });
    expect(dry.startsWith(`${id}: would remove worktree, local branch factory/12-`)).toBe(true);
    expect(dry).toMatch(/: would remove worktree, local branch factory\/12-[\w-]+\n\nNothing was removed \(--dry-run\)\.$/);
    expect(existsSync(worktree)).toBe(true);
    expect(runCleanup(dir)).toMatch(new RegExp(`^${id}: removed worktree, local branch factory/12-`));
    expect(existsSync(worktree)).toBe(false);
    expect(runCleanup(dir)).toBe("Nothing to clean up.");
  });
});
