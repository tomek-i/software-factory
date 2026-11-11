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

  it("marks factory comments", () => {
    expect(factoryComment("run-1-a", "triage-reject", "  nope  ")).toBe("<!-- factory:run-1-a:triage-reject -->\nnope\n");
  });
});
