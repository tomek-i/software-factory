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

  it("finds open PRs by the start of their branch name", () => {
    const list = fakeGh(JSON.stringify([{ number: 5, headRefName: "factory/lessons-1" }, { number: 6, headRefName: "factory/12-x" }]));
    expect(ghPort(project, list.run).findOpenPullRequests("factory/lessons-")).toEqual([{ number: 5, head: "factory/lessons-1" }]);
    expect(list.calls[0]).toEqual(["pr", "list", "-R", "o/r", "--state", "open", "--json", "number,headRefName", "--limit", "200"]);
    expect(() => ghPort(project, fakeGh("{}").run).findOpenPullRequests("x")).toThrow(/unexpected output/);
  });

  it("opens a ready (non-draft) PR with its description from a file, which it removes afterwards", () => {
    let sent = "";
    const calls: string[][] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args);
      sent = readFileSync(args.at(-1)!, "utf8");
      return { code: 0, stdout: "https://github.com/o/r/pull/43\n", stderr: "" };
    };
    expect(ghPort(project, run).createPullRequest({ head: "factory/lessons-1", base: "main", title: "T", body: "B" })).toBe(43);
    expect(calls[0]!.slice(0, -1)).toEqual(["pr", "create", "-R", "o/r", "--head", "factory/lessons-1", "--base", "main", "--title", "T", "--body-file"]);
    expect(sent).toBe("B");
    expect(existsSync(calls[0]!.at(-1)!)).toBe(false);
    expect(() => ghPort(project, fakeGh("created").run).createPullRequest({ head: "h", base: "b", title: "t", body: "" })).toThrow(/unexpected output/);
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

  it("squashes under the PR's title, or rebases, still only at the commit that passed", () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args);
      return { code: 0, stdout: args[1] === "view" ? JSON.stringify({ title: "feat(cli): colour the overview" }) : "", stderr: "" };
    };
    ghPort(project, run).mergePullRequest(42, "abc", "squash");
    ghPort(project, run).mergePullRequest(42, "abc", "rebase");
    expect(calls).toEqual([
      ["pr", "view", "42", "-R", "o/r", "--json", "title"],
      ["pr", "merge", "42", "-R", "o/r", "--squash", "--match-head-commit", "abc", "--subject", "feat(cli): colour the overview (#42)"],
      ["pr", "merge", "42", "-R", "o/r", "--rebase", "--match-head-commit", "abc"],
    ]);
    expect(() => ghPort(project, fakeGh(JSON.stringify({ title: "" })).run).mergePullRequest(42, "abc", "squash")).toThrow(/no title/);
  });

  it("reads the required checks, also while gh exits non-zero for a failed or pending one", () => {
    const listed = [
      { name: "test (ubuntu-latest)", bucket: "pending", link: "https://ci/1" },
      { name: "pr-title", bucket: "fail", link: "" },
    ];
    const calls: string[][] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args);
      return { code: 8, stdout: JSON.stringify(listed), stderr: "" };
    };
    expect(ghPort(project, run).requiredChecks(42)).toEqual([
      { name: "test (ubuntu-latest)", bucket: "pending", link: "https://ci/1" },
      { name: "pr-title", bucket: "fail" },
    ]);
    expect(calls[0]).toEqual(["pr", "checks", "42", "-R", "o/r", "--required", "--json", "name,bucket,link"]);

    const none: CommandRunner = () => ({ code: 1, stdout: "", stderr: "no required checks reported on the 'x' branch" });
    expect(ghPort(project, none).requiredChecks(42)).toEqual([]);
    const broken: CommandRunner = () => ({ code: 1, stdout: "", stderr: "HTTP 502" });
    expect(() => ghPort(project, broken).requiredChecks(42)).toThrow(/gh pr checks failed: HTTP 502/);
    expect(() => ghPort(project, fakeGh(JSON.stringify([{ name: "x", bucket: "weird" }])).run).requiredChecks(42)).toThrow(/unexpected output/);
  });

  it("opens an issue from a body file, which it removes afterwards, and returns its number", () => {
    let sent = "";
    const calls: string[][] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args);
      sent = readFileSync(args.at(-1)!, "utf8");
      return { code: 0, stdout: "https://github.com/o/r/issues/31", stderr: "" };
    };
    expect(ghPort(project, run).createIssue({ title: "Add export", body: "## Why\nx\n" })).toBe(31);
    expect(calls[0]!.slice(0, -1)).toEqual(["issue", "create", "-R", "o/r", "--title", "Add export", "--body-file"]);
    expect(sent).toBe("## Why\nx\n");
    expect(existsSync(calls[0]!.at(-1)!)).toBe(false);
    expect(() => ghPort(project, fakeGh("created").run).createIssue({ title: "t", body: "b" })).toThrow(/unexpected output: created. The issue "t" may have been created anyway; check GitHub/);
  });

  it("links a sub-issue by the node ids of both issues", () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_cmd, args) => {
      calls.push(args);
      const stdout = args[1] === "view" ? JSON.stringify({ id: `I_${args[2]}` }) : '{"data":{"addSubIssue":{"issue":{"number":10}}}}';
      return { code: 0, stdout, stderr: "" };
    };
    ghPort(project, run).addSubIssue(10, 11);
    expect(calls).toEqual([
      ["issue", "view", "10", "-R", "o/r", "--json", "id"],
      ["issue", "view", "11", "-R", "o/r", "--json", "id"],
      [
        "api",
        "graphql",
        "-f",
        "query=mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c}){issue{number}}}",
        "-f",
        "p=I_10",
        "-f",
        "c=I_11",
      ],
    ]);
    expect(() => ghPort(project, fakeGh("{}").run).addSubIssue(10, 11)).toThrow(/no id for #10/);
    expect(() => ghPort(project, fakeGh("", 1).run).addSubIssue(10, 11)).toThrow(/gh issue view failed: boom/);
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
