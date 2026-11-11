import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../util/exec.js";
import type { Project } from "../store/store.js";
import { GithubError } from "./issues.js";
import { factoryComment, ghPort } from "./port.js";

const project: Project = { id: "p", name: "demo", repo_path: "/repo", github_repo: "o/r", created_at: "" };

function fakeGh(stdout: string, code = 0) {
  const calls: string[][] = [];
  const run: CommandRunner = (_cmd, args) => {
    calls.push(args);
    return { code, stdout, stderr: code ? "boom" : "" };
  };
  return { calls, run };
}

describe("ghPort", () => {
  it("opens a draft PR against the base branch and returns its number", () => {
    const { calls, run } = fakeGh("https://github.com/o/r/pull/42");
    const pr = ghPort(project, run).createDraftPullRequest({ head: "factory/1-x", base: "main", title: "T", body: "B" });
    expect(pr).toBe(42);
    expect(calls[0]).toEqual(["pr", "create", "-R", "o/r", "--draft", "--head", "factory/1-x", "--base", "main", "--title", "T", "--body", "B"]);
  });

  it("replaces a PR's description from a file, which it removes afterwards", () => {
    let sent = "";
    const calls: string[][] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args);
      sent = readFileSync(args.at(-1)!, "utf8");
      return { code: 0, stdout: "", stderr: "" };
    };
    ghPort(project, run).updatePullRequest(42, "new body");
    expect(calls[0]!.slice(0, -1)).toEqual(["pr", "edit", "42", "-R", "o/r", "--body-file"]);
    expect(sent).toBe("new body");
    expect(existsSync(calls[0]!.at(-1)!)).toBe(false);
  });

  it("reads a PR's state, draft flag, head and merge commit", () => {
    const merged = fakeGh(JSON.stringify({ number: 42, state: "MERGED", isDraft: false, headRefOid: "h1", mergeCommit: { oid: "m1" } }));
    expect(ghPort(project, merged.run).pullRequestState(42)).toEqual({ number: 42, state: "merged", draft: false, head: "h1", mergeCommit: "m1" });
    expect(merged.calls[0]).toEqual(["pr", "view", "42", "-R", "o/r", "--json", "number,state,isDraft,headRefOid,mergeCommit"]);
    const open = fakeGh(JSON.stringify({ number: 42, state: "OPEN", isDraft: true, headRefOid: "h1", mergeCommit: null }));
    expect(ghPort(project, open.run).pullRequestState(42)).toEqual({ number: 42, state: "open", draft: true, head: "h1" });
    for (const out of ["nope", JSON.stringify({ number: 41, state: "OPEN", headRefOid: "h" }), JSON.stringify({ number: 42, state: "WEIRD", headRefOid: "h" })]) {
      expect(() => ghPort(project, fakeGh(out).run).pullRequestState(42)).toThrow(/unexpected output/);
    }
  });

  it("marks a PR ready and merges it only at the commit that passed", () => {
    const { calls, run } = fakeGh("");
    ghPort(project, run).markReady(42);
    ghPort(project, run).mergePullRequest(42, "abc");
    expect(calls).toEqual([
      ["pr", "ready", "42", "-R", "o/r"],
      ["pr", "merge", "42", "-R", "o/r", "--merge", "--match-head-commit", "abc"],
    ]);
    expect(() => ghPort(project, fakeGh("", 1).run).mergePullRequest(42, "abc")).toThrow(/gh pr merge failed: boom/);
  });

  it("finds an open PR for a branch", () => {
    expect(ghPort(project, fakeGh('[{"number":5}]').run).findPullRequest("b")).toBe(5);
    expect(ghPort(project, fakeGh("[]").run).findPullRequest("b")).toBeUndefined();
  });

  it("reports gh failures and unexpected output", () => {
    expect(() => ghPort(project, fakeGh("", 1).run).commentOnIssue(1, "x")).toThrow(/gh issue comment failed: boom/);
    expect(() => ghPort(project, fakeGh("created").run).createDraftPullRequest({ head: "h", base: "b", title: "t", body: "" })).toThrow(
      GithubError,
    );
    expect(() => ghPort({ ...project, github_repo: null })).toThrow(/no GitHub repository/);
  });

  it("finds the latest of its own comments that starts with a marker, by its REST id", () => {
    const comment = (body: string, id: number, viewerDidAuthor = true) => ({ body, viewerDidAuthor, url: `https://github.com/o/r/issues/3#issuecomment-${id}` });
    const { calls, run } = fakeGh(
      JSON.stringify({
        comments: [
          comment("<!-- factory:refine -->\nold", 11),
          comment("<!-- factory:refine -->\nnewer", 12),
          comment("<!-- factory:refine -->\nsomeone else pasted the marker", 13, false),
          comment("quoting <!-- factory:refine --> later on", 14),
        ],
      }),
    );
    expect(ghPort(project, run).findComment(3, "<!-- factory:refine -->")).toBe(12);
    expect(calls[0]).toEqual(["issue", "view", "3", "-R", "o/r", "--json", "comments"]);
    expect(ghPort(project, fakeGh(JSON.stringify({ comments: [] })).run).findComment(3, "<!-- factory:refine -->")).toBeUndefined();
    expect(() => ghPort(project, fakeGh("nope").run).findComment(3, "x")).toThrow(/unexpected output/);
    const noId = fakeGh(JSON.stringify({ comments: [{ body: "x", viewerDidAuthor: true, url: "https://github.com/o/r/issues/3" }] }));
    expect(() => ghPort(project, noId.run).findComment(3, "x")).toThrow(/without its id/);
  });

  it("edits a comment through the API, sending the body from a file it removes afterwards", () => {
    let sent = "";
    const calls: string[][] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args);
      sent = readFileSync(/^body=@(.+)$/.exec(args[5]!)![1]!, "utf8");
      return { code: 0, stdout: "", stderr: "" };
    };
    ghPort(project, run).editComment(12, "new text");
    expect(calls[0]).toEqual(["api", "-X", "PATCH", "repos/o/r/issues/comments/12", "-F", expect.stringMatching(/^body=@/), "--silent"]);
    expect(sent).toBe("new text");
    expect(existsSync(calls[0]![5]!.slice("body=@".length))).toBe(false);
    expect(() => ghPort(project, fakeGh("", 1).run).editComment(12, "x")).toThrow(/gh api -X failed: boom/);
  });

  it("marks factory comments", () => {
    expect(factoryComment("run-1-a", "triage-reject", "  nope  ")).toBe("<!-- factory:run-1-a:triage-reject -->\nnope\n");
  });
});
