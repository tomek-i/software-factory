import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { git, GIT_TEST_TIMEOUT, repoWithRemote } from "./helpers.js";

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

// realpath: Windows can name one folder by its short 8.3 name (RUNNER~1) or its long one.
const real = (p: string) => realpathSync.native(resolve(p)).replace(/\\/g, "/").toLowerCase();
const same = (a: string, b: string) => expect(real(a)).toBe(real(b));

describe("repoWithRemote", () => {
  it("gives every call its own repo whose origin is its own remote.git", () => {
    const files = { "README.md": "# same files\n", "src/a.txt": "a\n" };
    const one = repoWithRemote(files);
    const two = repoWithRemote(files);

    expect(one.base).not.toBe(two.base);
    for (const repo of [one, two]) {
      expect(repo.root).toBe(join(repo.base, "work"));
      expect(repo.remote).toBe(join(repo.base, "remote.git"));
      same(git(repo.root, "remote", "get-url", "origin"), repo.remote);
      same(git(repo.root, "rev-parse", "--absolute-git-dir"), join(repo.root, ".git"));
      expect(git(repo.root, "status", "--porcelain")).toBe("");
      expect(git(repo.root, "worktree", "list").split("\n")).toHaveLength(1);
      expect(git(repo.root, "rev-parse", "main")).toBe(git(repo.remote, "rev-parse", "main"));
      expect(git(repo.root, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
      expect(readFileSync(join(repo.root, "src", "a.txt"), "utf8")).toBe("a\n");
      expect(git(repo.root, "config", "user.email")).toBe("factory@example.invalid");
      expect(git(repo.root, "config", "core.autocrlf")).toBe("false");
    }
  });

  it("keeps copies of the same template independent: a push to one is not in the other", () => {
    const one = repoWithRemote();
    const two = repoWithRemote();
    const start = git(two.remote, "rev-parse", "main");

    writeFileSync(join(one.root, "pushed.txt"), "only in one\n");
    git(one.root, "add", "-A");
    git(one.root, "commit", "-qm", "only in one");
    git(one.root, "push", "-q", "origin", "main");
    git(one.root, "push", "-q", "origin", "main:refs/heads/side");

    expect(git(one.remote, "rev-parse", "main")).toBe(git(one.root, "rev-parse", "HEAD"));
    expect(git(two.remote, "rev-parse", "main")).toBe(start);
    expect(git(two.remote, "branch", "--list", "side")).toBe("");
    expect(git(repoWithRemote().remote, "rev-parse", "main")).toBe(start);
  });

  it("builds the files it is given into the first commit, whatever the order", () => {
    const one = repoWithRemote({ "b.txt": "b\n", "a.txt": "a\n" });
    const two = repoWithRemote({ "a.txt": "a\n", "b.txt": "b\n" });
    const other = repoWithRemote({ "a.txt": "other\n", "b.txt": "b\n" });

    expect(git(one.root, "ls-tree", "--name-only", "main").split("\n")).toEqual(["a.txt", "b.txt"]);
    expect(git(one.root, "rev-parse", "main^{tree}")).toBe(git(two.root, "rev-parse", "main^{tree}"));
    expect(git(other.root, "show", "main:a.txt")).toBe("other");
  });
});
