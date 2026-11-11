import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { git, GIT_TEST_TIMEOUT, repoWithRemote, tempDir } from "../../test/helpers.js";
import { branchName, createWorktree, gitEvidence, GitError, removeWorktree, slugify } from "./worktrees.js";

// Each test drives real git repos and child processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("slugify / branchName", () => {
  it("produces safe branch names", () => {
    expect(slugify("Add CSV export (v2)!")).toBe("add-csv-export-v2");
    expect(slugify("Crème brûlée für Ärzte")).toBe("creme-brulee-fur-arzte");
    expect(slugify("../../etc/passwd .. ~^:?*[")).toBe("etc-passwd");
    expect(slugify("日本語")).toBe("work");
    expect(slugify("a".repeat(30) + " " + "b".repeat(30))).toHaveLength(40);
    expect(slugify("word ".repeat(20))).not.toMatch(/-$/);
    expect(branchName(12, "Fix the login page")).toBe("factory/12-fix-the-login-page");
    expect(branchName(null, "idea")).toBe("factory/new-idea");
  });

  it("only yields names git accepts", () => {
    const dir = tempDir();
    for (const title of ["Fix: a..b", "  spaces  ", "émoji 🚀 time", "trailing.lock", "@{weird}"]) {
      expect(() => git(dir, "check-ref-format", "--branch", branchName(1, title))).not.toThrow();
    }
  });
});

describe("worktrees", () => {
  it("creates the worktree from the latest remote default branch, not the local checkout", () => {
    const { root, base } = repoWithRemote();
    // Someone else pushes to main; the local checkout does not have it yet.
    const other = join(base, "other");
    git(base, "clone", "-q", join(base, "remote.git"), other);
    git(other, "-c", "user.email=o@example.invalid", "-c", "user.name=o", "commit", "--allow-empty", "-qm", "upstream");
    git(other, "push", "-q", "origin", "main");
    const upstream = git(other, "rev-parse", "HEAD");
    // And the local checkout has an unpushed commit that must not leak into the run.
    git(root, "commit", "--allow-empty", "-qm", "local only");

    const wt = createWorktree({ root, runId: "run-1-abc", branch: "factory/1-thing", defaultBranch: "main" });

    expect(wt).toEqual({ path: join(root, ".worktrees", "run-1-abc"), branch: "factory/1-thing" });
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(upstream);
    expect(git(wt.path, "branch", "--show-current")).toBe("factory/1-thing");
  });

  it("never reuses a branch an earlier run left behind", () => {
    const { root } = repoWithRemote();
    const first = createWorktree({ root, runId: "run-1-a", branch: "factory/1-thing", defaultBranch: "main" });
    const second = createWorktree({ root, runId: "run-1-b", branch: "factory/1-thing", defaultBranch: "main" });
    expect(first.branch).toBe("factory/1-thing");
    expect(second.branch).toBe("factory/1-thing-2");
  });

  it("refuses to create over an existing worktree", () => {
    const { root } = repoWithRemote();
    createWorktree({ root, runId: "run-1-a", branch: "factory/1-x", defaultBranch: "main" });
    expect(() => createWorktree({ root, runId: "run-1-a", branch: "factory/1-y", defaultBranch: "main" })).toThrow(GitError);
  });

  it("removes a worktree, keeping the branch unless asked", () => {
    const { root } = repoWithRemote();
    const wt = createWorktree({ root, runId: "run-1-a", branch: "factory/1-x", defaultBranch: "main" });
    removeWorktree(root, wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(root, "branch", "--list", wt.branch)).toContain("factory/1-x");

    const again = createWorktree({ root, runId: "run-1-b", branch: "factory/1-y", defaultBranch: "main" });
    removeWorktree(root, again, { deleteBranch: true });
    expect(git(root, "branch", "--list", again.branch)).toBe("");
  });

  it("handles paths past the 260-character Windows limit", () => {
    const { root } = repoWithRemote();
    const wt = createWorktree({ root, runId: "run-1-a", branch: "factory/1-x", defaultBranch: "main" });
    const dir = join(wt.path, ...Array.from({ length: 10 }, (_, i) => `node_modules_like_directory_${i}`));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "deep.txt");
    writeFileSync(file, "deep\n");
    expect(file.length).toBeGreaterThan(260);

    git(wt.path, "add", "-A");
    expect(git(wt.path, "status", "--porcelain")).toContain("deep.txt");
  });
});

describe("gitEvidence", () => {
  it("reports head, cleanliness, commits ahead and push state from a real repo", () => {
    const { root } = repoWithRemote();
    const wt = createWorktree({ root, runId: "run-1-a", branch: "factory/1-x", defaultBranch: "main" });
    const evidence = gitEvidence(wt, "main");

    expect(evidence.commitsAhead()).toBe(0);
    expect(evidence.isClean()).toBe(true);
    expect(evidence.isPushed()).toBe(false);

    writeFileSync(join(wt.path, "feature.txt"), "x\n");
    expect(evidence.isClean()).toBe(false);

    git(wt.path, "add", "-A");
    git(wt.path, "-c", "user.email=f@example.invalid", "-c", "user.name=f", "commit", "-qm", "feature");
    expect(evidence.isClean()).toBe(true);
    expect(evidence.commitsAhead()).toBe(1);
    expect(evidence.head()).toBe(git(wt.path, "rev-parse", "HEAD"));
    expect(evidence.isPushed()).toBe(false);

    git(wt.path, "push", "-q", "origin", wt.branch);
    expect(evidence.isPushed()).toBe(true);

    git(wt.path, "-c", "user.email=f@example.invalid", "-c", "user.name=f", "commit", "--allow-empty", "-qm", "more");
    expect(evidence.isPushed()).toBe(false);
  });
});
