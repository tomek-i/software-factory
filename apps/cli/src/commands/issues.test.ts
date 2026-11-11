import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand, Store, type CommandRunner, type GithubPort } from "@factory/core";
import { runInit } from "./init.js";
import { createStyle, styleFor } from "../style.js";
import { runIssues, runQueue, runSync } from "./issues.js";

// eslint-disable-next-line no-control-regex -- matching escape characters is the point
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const issue = (number: number, state = "OPEN", author = "alice") => ({
  number,
  title: `Issue ${number}`,
  body: "",
  state,
  author: { login: author },
  labels: [],
  url: `https://github.com/acme/shop/issues/${number}`,
  updatedAt: "2026-11-01T00:00:00Z",
});

/**
 * Real git, fake gh logged in as alice. Lists #1 (alice) and #2 (mallory, untrusted);
 * view serves any number, with #9 closed and #404 missing.
 */
const run: CommandRunner = (cmd, args, opts) => {
  if (cmd !== "gh") return runCommand(cmd, args, opts);
  if (args[0] === "api") return { code: 0, stdout: "alice", stderr: "" };
  if (args[1] === "list") return { code: 0, stdout: JSON.stringify([issue(1), issue(2, "OPEN", "mallory")]), stderr: "" };
  if (args[1] === "view") {
    const n = Number(args[2]);
    if (n === 404) return { code: 1, stdout: "", stderr: "Could not resolve to an issue" };
    return { code: 0, stdout: JSON.stringify(issue(n, n === 9 ? "CLOSED" : "OPEN")), stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-issues-"));
  runCommand("git", ["init", "-q"], { cwd: dir });
  runCommand("git", ["remote", "add", "origin", "https://github.com/acme/shop.git"], { cwd: dir });
  runInit(dir, run);
  return dir;
}

describe("issue commands", () => {
  it("syncs, queues and lists issues", () => {
    const dir = repo();

    expect(runSync(dir, run)).toBe("Synced acme/shop: 2 open, 0 closed since last sync, 0 queued.");
    expect(runQueue(dir, ["#1"], true, run)).toBe("Queued #1 Issue 1");

    const all = runIssues(dir, {}, run);
    expect(all).toContain("Q #1  Issue 1  @alice");
    expect(all).toContain("  #2  Issue 2  @mallory (untrusted)");

    expect(runIssues(dir, { queued: true }, run)).toBe("Q #1  Issue 1  @alice");
    expect(runQueue(dir, ["1"], false, run)).toBe("Unqueued #1 Issue 1");
    expect(runIssues(dir, { queued: true }, run)).toBe("No issues.");
  });

  it("treats an issue the factory created as trusted, also after syncing it again", () => {
    const dir = repo();
    runSync(dir, run);
    const store = new Store(join(dir, ".factory", "factory.db"));
    store.markCreatedByFactory(store.listProjects()[0]!.id, 2);
    store.close();

    runSync(dir, run);

    expect(runIssues(dir, {}, run)).toContain("  #2  Issue 2  @mallory\n");
    expect(runQueue(dir, ["2"], true, run)).toBe("Queued #2 Issue 2");
  });

  it("lets you queue an untrusted issue but says what that means", () => {
    const dir = repo();
    runSync(dir, run);
    const output = runQueue(dir, ["2"], true, run);
    expect(output).toMatch(/^Queued #2 Issue 2\n/);
    expect(output).toContain("triage will wait for your approval");
  });

  it("fetches an unsynced issue when queueing it, and skips closed ones", () => {
    const dir = repo();
    expect(runQueue(dir, ["5", "9", "404"], true, run)).toBe(
      "Queued #5 Issue 5\nSkipped #9: issue #9 is closed\nSkipped #404: gh issue view failed: Could not resolve to an issue",
    );
  });

  it("styles the list without changing its text or alignment, and not at all with NO_COLOR or a pipe", () => {
    const dir = repo();
    runSync(dir, run);
    runQueue(dir, ["10"], true, run);

    const coloured = runIssues(dir, {}, run, createStyle(true));
    expect(coloured).toContain("\x1b[");
    expect(strip(coloured)).toBe(runIssues(dir, {}, run));
    expect(strip(coloured)).toContain("  #2   Issue 2  @mallory (untrusted)");

    for (const style of [styleFor({ isTTY: true }, { NO_COLOR: "1" }), styleFor({ isTTY: false }, {})]) {
      expect(runIssues(dir, {}, run, style)).toBe(runIssues(dir, {}, run));
    }
  });

  it("finishes runs whose PR was merged on GitHub when syncing", () => {
    const dir = repo();
    const store = new Store(join(dir, ".factory", "factory.db"));
    const created = store.createRun({ project_id: store.listProjects()[0]!.id, title: "t", issue_number: 1 });
    store.writeState(created.id, "needs_human", { pr_number: 3, waiting_gate: "review" });
    store.close();
    const github: GithubPort = {
      commentOnIssue: () => undefined,
      findPullRequest: () => undefined,
      createDraftPullRequest: () => 1,
      updatePullRequest: () => undefined,
    markReady: () => undefined,
    mergePullRequest: () => undefined,
      pullRequestState: (number) => ({ number, state: "merged", draft: false, head: "h", mergeCommit: "c".repeat(40) }),
    };

    expect(runSync(dir, run, github)).toBe(`${created.id}: PR #3 merged -> done\nSynced acme/shop: 2 open, 0 closed since last sync, 0 queued.`);
    expect(runSync(dir, run, github)).toBe("Synced acme/shop: 2 open, 0 closed since last sync, 0 queued.");
  });

  it("rejects things that are not issue numbers", () => {
    const dir = repo();
    expect(() => runQueue(dir, ["abc"], true, run)).toThrow(/not an issue number/);
  });

  it("asks for init in an unregistered repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-issues-"));
    runCommand("git", ["init", "-q"], { cwd: dir });
    expect(() => runSync(dir, run)).toThrow(/factory init/);
  });
});
