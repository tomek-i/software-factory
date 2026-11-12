import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MEDIA_MARKER, mediaTag, runCommand, Store, type CommandRunner } from "@factory/core";
import { git, GIT_TEST_TIMEOUT, reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, github, merged, setup, TRIAGE } from "../../test/runs-setup.js";
import { CliError } from "../context.js";
import { runApprove, runCancel, runReject, runResume, runStatus } from "./runs.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("approve / reject / cancel", () => {
  it("only acts on runs waiting at a gate", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();

    expect(() => runReject(dir, "#12", { message: " " })).toThrow(/Say why/);
    const approved = await runApprove(dir, "#12", { message: "go", run: false });
    expect(approved).toContain("Approved the triage gate");
    expect(approved).toContain("factory run 12");
    expect(runStatus(dir, {}, { github })).toMatch(/\bbuild\b/);
    await expect(runApprove(dir, "#12", {})).rejects.toThrow(/not waiting at a gate \(it is build\)/);
    expect(() => runReject(dir, "#12", { message: "no" })).toThrow(CliError);
  });

  it("keeps driving the run after an approval", async () => {
    const { run, queue, dir, deps, printed, root } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()], "triage: human");
    queue();
    await run();

    const message = await runApprove(dir, "12", { message: "go" }, deps);

    expect(printed.some((l) => /^Approved the triage gate of run-12-\w+; it moves to build\.$/.test(l))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);
    expect(message).toMatch(/waiting at the review gate/);
    // Approving the review gate drives on through capture and the PR to the merge gate.
    expect(await runApprove(dir, "12", {}, deps)).toMatch(/is waiting at the merge gate: waiting at merge gate: gate is set to human/);
    const s = new Store(join(root, ".factory", "factory.db"));
    const runId = s.listRuns({})[0]!.id;
    const head = git(s.getRun(runId)!.worktree_path!, "rev-parse", "HEAD");
    s.close();

    // Approving the merge gate records the commit that waited, and the factory merges exactly it.
    expect(await runApprove(dir, "12", { message: "ship it" }, deps)).toMatch(/finished: done/);
    expect(merged).toEqual([{ number: 7, head }]);
    const after = new Store(join(root, ".factory", "factory.db"));
    expect(after.listDecisions(runId).find((d) => d.comment === "ship it")).toMatchObject({ gate: "merge", commit_sha: head });
    after.close();
  });

  it("records an approval but does not drive a run whose issue was unqueued", async () => {
    const { run, queue, dir, deps, root, fake } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    const s = new Store(join(root, ".factory", "factory.db"));
    s.setQueued(s.listProjects()[0]!.id, 12, false);
    s.close();

    const message = await runApprove(dir, "12", {}, deps);

    expect(message).toMatch(/moves to build\.\nIssue #12 is no longer queued, so the run was not continued/);
    expect(runStatus(dir, {}, { github })).toMatch(/\bbuild\b/);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage"]);
  });

  it("rejects a waiting run with a reason", async () => {
    const { run, queue, dir } = setup([{ output: TRIAGE }], "triage: human");
    queue();
    await run();
    expect(runReject(dir, "#12", { message: "not now" })).toContain("Rejected");
    expect(runStatus(dir, { all: true }, { github })).toMatch(/rejected/);
  });

  it("approves an incomplete issue at triage into refine, and the critic gate into build", async () => {
    const incomplete = TRIAGE.replace("READINESS: READY", "READINESS: INCOMPLETE");
    const refined = { role: "refine", output: "STATUS: REFINED\n\n## Summary\n- spec\n\n## Acceptance criteria\n- [ ] feature.txt exists\n" };
    const { run, queue, dir, deps, printed, fake } = setup([{ output: incomplete }, refined, BUILD, ...reviewsPass()], "triage: human\n  critic: human");
    queue();
    await run();

    const waiting = await runApprove(dir, "12", { message: "go" }, deps);
    expect(waiting).toMatch(/is waiting at the critic gate: waiting at critic gate: gate is set to human/);
    expect(waiting).toMatch(/^See it with: `factory show run-12-\w+ critic`\.$/m);
    expect(printed.some((l) => /^Approved the triage gate of run-12-\w+; it moves to refine\.$/.test(l))).toBe(true);

    expect(await runApprove(dir, "12", { message: "spec is fine" }, deps)).toMatch(/waiting at the review gate/);
    expect(printed.some((l) => /^Approved the critic gate of run-12-\w+; it moves to build\.$/.test(l))).toBe(true);
    expect(fake.calls().map((c) => c.role).slice(0, 3)).toEqual(["triage", "refine", "builder"]);
    expect(fake.calls().find((c) => c.role === "builder")!.stdin).toContain("feature.txt exists");
  });

  it("routes an approval by the default branch's config, not a local edit of it", async () => {
    const { run, queue, dir, root } = setup([{ output: TRIAGE }], "triage: human\n  critic: auto");
    queue();
    await run();
    // A local copy that would skip the critic, never committed: the approval must not follow it.
    const file = join(root, ".factory", "config.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("critic: auto", "critic: always"));

    expect(await runApprove(dir, "12", { message: "go", run: false })).toContain("it moves to critic.");
  });

  it("resumes a run at the critic gate back to refine", async () => {
    const incomplete = TRIAGE.replace("READINESS: READY", "READINESS: INCOMPLETE");
    const refined = { role: "refine", output: "STATUS: REFINED\n\n## Summary\n- spec\n" };
    const { run, queue, dir, deps, fake } = setup([{ output: incomplete }, refined, refined], "critic: human");
    queue();
    await run();

    expect(await runResume(dir, "12", { to: "refine", message: "name the file" }, deps)).toMatch(/is waiting at the critic gate/);
    expect(fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "refine"]);
    expect(fake.calls()[2]!.stdin).toContain("name the file");
  });

  it("deletes the screenshots release of a run that ends unmerged, or says how to", async () => {
    const { run, queue, dir, root } = setup([{ output: TRIAGE }, { output: TRIAGE }], "triage: human");
    queue(12, 13);
    await run("12");
    await run("13");
    const runs = join(root, ".factory", "runs");
    const ids = readdirSync(runs).sort();
    // As if both runs had uploaded screenshots.
    for (const id of ids) writeFileSync(join(runs, id, MEDIA_MARKER), `${mediaTag(id)}\n`);
    const gh: string[][] = [];
    const runner =
      (fail: boolean): CommandRunner =>
      (cmd, args, options) => {
        if (cmd !== "gh") return runCommand(cmd, args, options);
        gh.push(args);
        return fail ? { code: 1, stdout: "", stderr: "HTTP 403" } : { code: 0, stdout: "", stderr: "" };
      };

    const [first, second] = ids as [string, string];
    expect(runReject(dir, first, { message: "not now" }, runner(false))).toContain(`Deleted its screenshots release factory-media-${first}.`);
    expect(gh).toEqual([["release", "delete", `factory-media-${first}`, "--yes", "-R", "o/r"]]);
    expect(existsSync(join(runs, first, MEDIA_MARKER))).toBe(false);

    const cancelled = runCancel(dir, second, {}, runner(true));
    expect(cancelled).toMatch(/^Cancelled /);
    expect(cancelled).toContain(`Could not delete its screenshots release (gh release delete failed: HTTP 403); delete it with \`gh release delete factory-media-${second}\`.`);
    // Kept, so a later cancel or reject does not lose track of the release.
    expect(existsSync(join(runs, second, MEDIA_MARKER))).toBe(true);
  });

  it("explains unknown run references", async () => {
    const { dir } = setup([]);
    await expect(runApprove(dir, "run-nope", {})).rejects.toThrow(/No run "run-nope"/);
    await expect(runApprove(dir, "#99", {})).rejects.toThrow(/No run for issue #99/);
  });
});
