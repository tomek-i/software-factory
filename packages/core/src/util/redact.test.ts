import { describe, expect, it } from "vitest";
import { redactPaths } from "./redact.js";

const windows = { home: "C:\\Users\\alice", roots: ["D:\\work\\repo"] };
const posix = { home: "/home/alice", roots: ["/srv/repo"] };

describe("redactPaths", () => {
  it("shortens a Windows path in Node's import error and keeps what went wrong", () => {
    const err = "Cannot find package 'playwright' imported from C:\\Users\\alice\\repo\\packages\\core\\dist\\capture\\browser.js";
    expect(redactPaths(err, windows)).toBe("Cannot find package 'playwright' imported from ~\\repo\\packages\\core\\dist\\capture\\browser.js");
    // Any case and either separator, as git prints it.
    expect(redactPaths("fatal: c:/users/ALICE/repo: not a git repository", windows)).toBe("fatal: ~/repo: not a git repository");
    expect(redactPaths("at file:///C:/Users/alice/repo/x.js:3:1", windows)).toBe("at ~/repo/x.js:3:1");
  });

  it("shortens a POSIX path the same way", () => {
    const err = "Cannot find package 'playwright' imported from /home/alice/repo/packages/core/dist/capture/browser.js";
    expect(redactPaths(err, posix)).toBe("Cannot find package 'playwright' imported from ~/repo/packages/core/dist/capture/browser.js");
    expect(redactPaths("at file:///home/alice/repo/x.js:3:1", posix)).toBe("at ~/repo/x.js:3:1");
    expect(redactPaths("EACCES: permission denied, mkdir '/home/alice'", posix)).toBe("EACCES: permission denied, mkdir '~'");
  });

  it("makes a path in the repository relative to it, also outside the home folder", () => {
    expect(redactPaths("cannot read D:\\work\\repo\\packages\\core\\x.js", windows)).toBe("cannot read packages\\core\\x.js");
    expect(redactPaths("cannot read d:/Work/Repo/x.js", windows)).toBe("cannot read x.js");
    expect(redactPaths("cannot read /srv/repo/packages/core/x.js", posix)).toBe("cannot read packages/core/x.js");
    expect(redactPaths("cwd /srv/repo", posix)).toBe("cwd .");
    // The innermost root wins: a worktree inside the repository.
    expect(redactPaths("/srv/repo/.worktrees/r1/src/a.ts", { ...posix, roots: ["/srv/repo", "/srv/repo/.worktrees/r1"] })).toBe("src/a.ts");
    // Only the folder itself, not one whose name starts the same.
    expect(redactPaths("/srv/repository/x", posix)).toBe("/srv/repository/x");
  });

  it("shortens anyone's profile folder, not only the home folder it was given", () => {
    const other = { home: "/nowhere" };
    expect(redactPaths("from C:\\Users\\bob\\x.js and C:/Users/carol/y.js", other)).toBe("from ~\\x.js and ~/y.js");
    expect(redactPaths("from /home/bob/x.js and /Users/carol/y.js", other)).toBe("from ~/x.js and ~/y.js");
    // A path cut short still loses the name.
    expect(redactPaths("imported from C:\\Users\\ali", other)).toBe("imported from ~");
  });

  it("leaves app routes and URLs alone", () => {
    for (const text of [
      "HTTP 404: GET /invoices",
      "request failed: GET /api/users (net::ERR_FAILED)",
      "HTTP 404: GET /home/settings",
      "console error: fetch http://localhost:4700/x failed",
      "console error: fetch http://localhost:4700/home/alice failed",
      "no before shot of invoices (/invoices): it is a new screen",
      "narrate failed (exit 1); see narrate/narrate.log",
    ]) {
      expect(redactPaths(text, posix)).toBe(text);
      expect(redactPaths(text, windows)).toBe(text);
    }
  });

  it("ignores a filesystem root, which would match everything", () => {
    expect(redactPaths("/srv/x and C:\\x", { home: "/", roots: ["C:\\", "/"] })).toBe("/srv/x and C:\\x");
  });
});
