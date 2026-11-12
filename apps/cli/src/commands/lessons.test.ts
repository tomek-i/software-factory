import { describe, expect, it, vi } from "vitest";
import type { GithubPort } from "@factory/core";
import { git, GIT_TEST_TIMEOUT } from "../../../../packages/core/test/helpers.js";
import { github, prEdits, readyPrs, setup } from "../../test/runs-setup.js";
import { runLessons, runLessonsApprove, runLessonsReject } from "./lessons.js";
import { runStatus } from "./runs.js";

// Each test drives real git repos; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const lesson = (rule: string) => ({ observation: "The gate failed\non lint.", evidence: "round-1/checks.md", rule });

/** A registered repo with one finished run for #12 and the learner's proposals from it. */
function withLessons(...rules: string[]) {
  const ctx = setup([]);
  const store = ctx.db();
  const run = store.createRun({ project_id: ctx.projectId, title: "Add the feature", issue_number: 12 });
  const ids = store.addLessons(run.id, rules.map(lesson)).map((l) => l.id);
  store.close();
  return { ...ctx, runId: run.id, ids };
}

describe("factory lessons", () => {
  it("lists the proposed lessons, and every lesson with --all", () => {
    const { dir, runId, ids, db } = withLessons("Run lint first.", "Use pnpm, not npm.");
    const store = db();
    store.decideLessons([ids[1]!], "rejected", { comment: "already in the README" });
    store.close();

    const waiting = runLessons(dir);
    expect(waiting).toBe(
      [
        `${ids[0]}  proposed  ${runId} (#12)`,
        "    rule:      Run lint first.",
        "    observed:  The gate failed on lint.",
        "    evidence:  round-1/checks.md",
        "",
        'Approve with `factory lessons approve <id...>`, or reject with `factory lessons reject <id...> -m "<why>"`.',
      ].join("\n"),
    );
    expect(runLessons(dir, { all: true })).toContain(`${ids[1]}  rejected: already in the README  ${runId} (#12)`);
  });

  it("says when nothing waits", () => {
    const { dir } = setup([]);
    expect(runLessons(dir)).toBe("No lessons waiting. `factory lessons --all` shows decided ones.");
    expect(runLessons(dir, { all: true })).toBe("No lessons yet.");
  });

  it("approves several lessons in one ready PR that appends them to lessons.md, leaving main and the working copy alone", () => {
    const { dir, root, runId, ids, db } = withLessons("Run lint first.", "Use pnpm, not npm.", "Not this one.");
    const mainBefore = git(root, "rev-parse", "origin/main");

    const out = runLessonsApprove(dir, [String(ids[0]), `#${ids[1]}`], { github, now: new Date("2026-11-12T09:05:07Z") });

    expect(out).toBe(
      [
        `Approved lessons ${ids[0]}, ${ids[1]}. PR #8 adds them to .factory/lessons.md: https://github.com/o/r/pull/8`,
        "Agents read lessons from main, so they apply to runs that start after the PR is merged.",
      ].join("\n"),
    );
    expect(readyPrs).toHaveLength(1);
    expect(readyPrs[0]).toMatchObject({ head: "factory/lessons-20261112-090507-000", base: "main", title: "chore(factory): add 2 approved lessons" });
    expect(readyPrs[0]!.body).toContain(`- **Run lint first.**\n  From run \`${runId}\` (#12), lesson ${ids[0]}: The gate failed on lint.`);
    expect(readyPrs[0]!.body).toContain("- **Use pnpm, not npm.**");
    expect(readyPrs[0]!.body).not.toContain("Not this one.");

    git(root, "fetch", "-q", "origin");
    expect(git(root, "show", "origin/factory/lessons-20261112-090507-000:.factory/lessons.md")).toMatch(/\n- Run lint first\.\n- Use pnpm, not npm\.$/);
    expect(git(root, "rev-parse", "origin/main")).toBe(mainBefore);
    expect(git(root, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(root, "status", "--porcelain")).toBe("");

    const store = db();
    expect(store.listLessons({ project_id: store.listProjects()[0]!.id }).map((l) => [l.status, l.pull_request])).toEqual([
      ["approved", 8],
      ["approved", 8],
      ["proposed", null],
    ]);
    store.close();
    expect(runLessons(dir, { all: true })).toContain(`${ids[0]}  approved (PR #8)`);
  });

  it("approves nothing when the PR cannot be opened", () => {
    const { dir, ids, db } = withLessons("Run lint first.");
    const offline: GithubPort = {
      ...github,
      createPullRequest: () => {
        throw new Error("gh: not logged in");
      },
    };

    expect(() => runLessonsApprove(dir, [String(ids[0])], { github: offline })).toThrow(/Could not publish the lessons; nothing was approved: gh: not logged in/);
    const store = db();
    expect(store.getLesson(ids[0]!)!.status).toBe("proposed");
    store.close();
  });

  it("adds later approvals to the lessons PR that is still open, and lists every lesson in its description", () => {
    const { dir, root, ids, db } = withLessons("Run lint first.", "Use pnpm, not npm.");
    runLessonsApprove(dir, [String(ids[0])], { github });

    expect(runLessonsApprove(dir, [String(ids[1])], { github })).toMatch(/^Approved lesson \d+\. Added it to the open lessons PR #8: https:\/\/github\.com\/o\/r\/pull\/8\n/);
    expect(readyPrs).toHaveLength(1);
    expect(prEdits).toHaveLength(1);
    expect(prEdits[0]).toMatchObject({ number: 8, body: expect.stringContaining("Adds 2 lessons") });
    expect(prEdits[0]!.body).toContain("- **Run lint first.**");
    expect(prEdits[0]!.body).toContain("- **Use pnpm, not npm.**");
    git(root, "fetch", "-q", "origin");
    expect(git(root, "show", `origin/${readyPrs[0]!.head}:.factory/lessons.md`)).toMatch(/\n- Run lint first\.\n- Use pnpm, not npm\.$/);
    const store = db();
    expect(store.listLessons({ project_id: store.listProjects()[0]!.id }).map((l) => [l.status, l.pull_request])).toEqual([
      ["approved", 8],
      ["approved", 8],
    ]);
    store.close();
  });

  it("shows control and text-direction characters in a lesson instead of printing them", () => {
    const esc = String.fromCodePoint(0x1b);
    const rlo = String.fromCodePoint(0x202e);
    const { dir, db } = setup([]);
    const store = db();
    const run = store.createRun({ project_id: store.listProjects()[0]!.id, title: "t", issue_number: 12 });
    // The schema refuses these in a rule; stored text is escaped on output all the same.
    store.addLessons(run.id, [{ observation: `ok${esc}[2Khidden`, evidence: `a${rlo}b`, rule: `Run${esc}[8m secret` }]);
    store.close();

    const out = runLessons(dir);
    expect(out).toContain("rule:      Run[U+001B][8m secret");
    expect(out).toContain("observed:  ok[U+001B][2Khidden");
    expect(out).toContain("evidence:  a[U+202E]b");
    expect(out).not.toContain(esc);
    expect(out).not.toContain(rlo);
  });

  it("rejects lessons with an optional reason, and refuses ids that are unknown or already decided", () => {
    const { dir, ids, db } = withLessons("Run lint first.", "Be careful.");

    expect(runLessonsReject(dir, [String(ids[1])], { message: " too generic " })).toBe(`Rejected lesson ${ids[1]}.`);
    expect(runLessonsReject(dir, [String(ids[0])])).toBe(`Rejected lesson ${ids[0]}.`);
    const store = db();
    expect(store.getLesson(ids[1]!)).toMatchObject({ status: "rejected", comment: "too generic" });
    expect(store.getLesson(ids[0]!)).toMatchObject({ status: "rejected", comment: null });
    store.close();

    expect(() => runLessonsReject(dir, [String(ids[0]), "999"])).toThrow(`Lesson ${ids[0]} is already rejected.\nNo lesson 999.`);
    expect(() => runLessonsApprove(dir, [String(ids[0])], { github })).toThrow(/already rejected/);
    expect(() => runLessonsReject(dir, ["x"])).toThrow(/"x" is not a lesson id/);
    expect(readyPrs).toEqual([]);
  });

  it("notes waiting lessons in factory status", () => {
    const { dir, ids } = withLessons("Run lint first.", "Use pnpm, not npm.");
    expect(runStatus(dir, {}, { github })).toMatch(/\n\n2 lessons waiting: `factory lessons`$/);

    runLessonsReject(dir, [String(ids[0])]);
    expect(runStatus(dir, { all: true }, { github })).toMatch(/\n\n1 lesson waiting: `factory lessons`$/);
    runLessonsReject(dir, [String(ids[1])]);
    expect(runStatus(dir, {}, { github })).not.toContain("waiting:");
  });
});
