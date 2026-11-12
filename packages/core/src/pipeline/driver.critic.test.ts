import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { buildStep, setup, TRIAGE } from "../../test/driver-setup.js";
import { GIT_TEST_TIMEOUT, REVIEW_PASS, tempDir, type FakeStep } from "../../test/helpers.js";
import { approveTarget, latestSpecRound, nextAfterTriage, quietMentions, REFINE_MARKER, runDirOf } from "./driver.js";
import { RunMachine } from "./transitions.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

const config = (gates: string, extra = "") =>
  `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  ${gates}\n${extra}`;
const INCOMPLETE = TRIAGE().replace("READINESS: READY", "READINESS: INCOMPLETE");
const refined = (n: number): FakeStep => ({
  role: "refine",
  output: `STATUS: REFINED\n\n## Summary\n- spec ${n}\n\n## Acceptance criteria\n- [ ] feature.txt says fixed (v${n})\n\n## Scope\n- add feature.txt\n\n## Out of scope\n- anything else\n\n## Open questions\n- Which encoding? Assumed UTF-8 (v${n})\n`,
});
const accept: FakeStep = { role: "critic", output: "VERDICT: ACCEPT\n\n## Summary\n- holds\n\n## Notes\n- keep feature.txt to one line\n" };
const revise = (n: number): FakeStep => ({ role: "critic", output: `VERDICT: REVISE\n\n## Summary\n- not yet\n\n## Problems\n- criterion v${n} cannot be checked\n` });
// The builder stops right away: these tests are about what it was told, not what it builds.
const blockedBuild: FakeStep = { role: "builder", output: "STATUS: BLOCKED\nCOMMIT: {{HEAD}}\n\n## Blocker\nstopping here\n" };

describe("PipelineDriver", () => {
  describe("refine and spec critic", () => {
    it("sends a READY issue straight to the critic, and the builder gets the critic's notes", async () => {
      const { driver, store, fake, root, comments } = setup([{ output: TRIAGE() }, accept, blockedBuild], { config: config("critic: auto") });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "builder is blocked: stopping here" });

      expect(fake.calls().map((c) => c.role)).toEqual(["triage", "critic", "builder"]);
      const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
      expect(moves.slice(2, 4)).toEqual(["triage>critic", "critic>build"]);
      const dir = runDirOf(root, run.id);
      expect(existsSync(join(dir, "spec-1", "critic.md"))).toBe(true);
      expect(existsSync(join(dir, "spec-1", "refine.md"))).toBe(false);
      expect(comments).toEqual([]);
      expect(store.listDecisions(run.id).find((d) => d.gate === "critic")).toMatchObject({ outcome: "proceed", actor: "agent", mode: "auto" });
      const builder = fake.calls().find((c) => c.role === "builder")!.stdin;
      expect(builder).toContain("## Spec critic's notes");
      expect(builder).toContain("keep feature.txt to one line");
      expect(builder).not.toContain("## Refined spec");
      // The critic is read-only: no shell, and only its own file to write.
      const settings = JSON.parse(readFileSync(join(dir, "agent", "critic.settings.json"), "utf8")) as { permissions: { allow: string[]; deny: string[] } };
      expect(settings.permissions.deny).toContain("Bash");
      expect(settings.permissions.allow.filter((r) => r.startsWith("Edit("))).toEqual([expect.stringMatching(/spec-1\/critic\.md\)$/)]);
    });

    it("refines an INCOMPLETE issue, posts the spec on the issue and builds from it once the critic accepts", async () => {
      const { driver, store, fake, root, comments } = setup([{ output: INCOMPLETE }, refined(1), accept, blockedBuild], { config: config("critic: auto") });
      const run = driver.startRun(12);

      await driver.drive(run.id);

      expect(fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "critic", "builder"]);
      const moves = store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
      expect(moves.slice(2, 5)).toEqual(["triage>refine", "refine>critic", "critic>build"]);
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body.startsWith(`${REFINE_MARKER}\n`)).toBe(true);
      expect(comments[0]!.body).toContain("### Acceptance criteria\n- [ ] feature.txt says fixed (v1)");
      expect(comments[0]!.body).toContain("### Out of scope\n- anything else");
      expect(comments[0]!.body).not.toContain("spec 1"); // the summary is for the run, not the issue
      // The critic checks the refined spec, and the builder gets it with the critic's notes.
      expect(fake.calls()[2]!.stdin).toContain("## Refined spec (round 1)");
      const builder = fake.calls()[3]!.stdin;
      expect(builder).toContain("## Refined spec\n");
      expect(builder).toContain("feature.txt says fixed (v1)");
      expect(builder).toContain("## Spec critic's notes");
      const dir = runDirOf(root, run.id);
      expect(existsSync(join(dir, "spec-1", "refine.md")) && existsSync(join(dir, "spec-1", "critic.md"))).toBe(true);
      const settings = JSON.parse(readFileSync(join(dir, "agent", "refine.settings.json"), "utf8")) as { permissions: { allow: string[]; deny: string[] } };
      expect(settings.permissions.deny).toContain("Bash");
      expect(settings.permissions.allow.filter((r) => r.startsWith("Edit("))).toEqual([expect.stringMatching(/spec-1\/refine\.md\)$/)]);
    });

    it("loops REVISE back to refine, updates the one spec comment in place, and escalates at the round cap with what is still open", async () => {
      const { driver, store, fake, root, comments } = setup([{ output: INCOMPLETE }, refined(1), revise(1), refined(2), revise(2)], {
        config: config("critic: auto", "loops:\n  max_critic_rounds: 2\n"),
      });
      const run = driver.startRun(12);

      const outcome = await driver.drive(run.id);

      expect(outcome).toMatchObject({ kind: "parked", state: "needs_human" });
      const reason = (outcome as { reason: string }).reason;
      expect(reason).toMatch(/^waiting at critic gate: the spec critic still asks for revisions after spec round 2: spec critic round cap reached \(2\)/);
      expect(reason).toContain("open: criterion v2 cannot be checked");
      expect(reason).toContain("open: Which encoding? Assumed UTF-8 (v2)");
      expect(store.getRun(run.id)).toMatchObject({ waiting_gate: "critic", critic_rounds: 1 });
      expect(fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "critic", "refine", "critic"]);

      // One comment, edited to the second round's spec rather than posted again.
      expect(comments).toHaveLength(1);
      expect(comments[0]!.edits).toBe(1);
      expect(comments[0]!.body).toContain("(spec round 2)");
      expect(comments[0]!.body).toContain("feature.txt says fixed (v2)");
      expect(comments[0]!.body).not.toContain("(v1)");

      // The second refine got the critic's problems and its own earlier spec; the second critic its earlier verdict.
      const [, , , refine2, critic2] = fake.calls();
      expect(refine2!.stdin).toContain("## The spec critic's verdict on round 1: REVISE");
      expect(refine2!.stdin).toContain("criterion v1 cannot be checked");
      expect(refine2!.stdin).toContain("## Your spec from round 1");
      expect(critic2!.stdin).toContain("## Your verdict on round 1: REVISE");
      expect(critic2!.stdin).toContain("## Refined spec (round 2)");

      // Every round keeps its own files.
      const dir = runDirOf(root, run.id);
      expect(readFileSync(join(dir, "spec-1", "critic.md"), "utf8")).toContain("criterion v1");
      expect(readFileSync(join(dir, "spec-2", "critic.md"), "utf8")).toContain("criterion v2");
      expect(readFileSync(join(dir, "spec-1", "refine.md"), "utf8")).toContain("(v1)");
      expect(readFileSync(join(dir, "spec-2", "refine.md"), "utf8")).toContain("(v2)");
      expect(latestSpecRound(dir)).toBe(2);
    });

    it("lets a human approve the critic gate into build, or send the spec back to refine with a comment", async () => {
      const { driver, store, fake, root } = setup([{ output: INCOMPLETE }, refined(1), revise(1), refined(2), accept, blockedBuild], {
        config: config("critic: auto", "loops:\n  max_critic_rounds: 1\n"),
      });
      const run = driver.startRun(12);
      await driver.drive(run.id);
      const parked = store.getRun(run.id)!;
      expect(parked.waiting_gate).toBe("critic");
      expect(approveTarget(parked, "build")).toBe("build");

      // Sent back instead, with a fresh round budget: refine starts a new round and gets the comment.
      const machine = new RunMachine(store, factoryConfigSchema.parse({ version: 1 }));
      machine.resume(run.id, "refine", { comment: "only check the file exists", resetLoops: true });
      await driver.drive(run.id);

      expect(fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "critic", "refine", "critic", "builder"]);
      const refine2 = fake.calls()[3]!.stdin;
      expect(refine2).toContain("## A human sent the spec back with this comment\nonly check the file exists");
      expect(refine2).toContain("## The spec critic's verdict on round 1: REVISE");
      expect(fake.calls()[5]!.stdin).toContain("feature.txt says fixed (v2)");
      expect(existsSync(join(runDirOf(root, run.id), "spec-2", "critic.md"))).toBe(true);
    });

    it("keeps the refined spec when a human sends the run back to the critic, but drops it once triage runs again", async () => {
      const { driver, store, fake } = setup([{ output: INCOMPLETE }, refined(1), revise(1), accept, blockedBuild], {
        config: config("critic: auto", "loops:\n  max_critic_rounds: 1\n"),
      });
      const run = driver.startRun(12);
      await driver.drive(run.id);
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "critic", { comment: "check it again" });
      await driver.drive(run.id);

      expect(fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "critic", "critic", "builder"]);
      expect(fake.calls()[3]!.stdin).toContain("## Refined spec (round 1)");
      expect(fake.calls()[4]!.stdin).toContain("feature.txt says fixed (v1)");

      const again = setup(
        [{ output: INCOMPLETE }, refined(1), { role: "critic", output: "VERDICT: ACCEPT\n\n## Summary\n- ok\n\n## Questions\n- JSON?\n" }, { output: TRIAGE() }, accept, blockedBuild],
        { config: config("critic: auto") },
      );
      const second = again.driver.startRun(12);
      await again.driver.drive(second.id);
      again.driver.retriage(second.id);
      await again.driver.drive(second.id);
      expect(again.fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "critic", "triage", "critic", "builder"]);
      expect(again.fake.calls()[4]!.stdin).not.toContain("## Refined spec");
      expect(again.fake.calls()[5]!.stdin).not.toContain("(v1)");
    });

    it("posts the reasons and ends the run when the critic rejects", async () => {
      const reject: FakeStep = { role: "critic", output: "VERDICT: REJECT\n\n## Summary\n- wrong\n\n## Problems\n- feature.txt already exists and says fixed\n" };
      const { driver, store, comments } = setup([{ output: TRIAGE() }, reject], { config: config("critic: auto") });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toEqual({ kind: "finished", state: "rejected" });
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toMatch(new RegExp(`^<!-- factory:${run.id}:critic-reject -->`));
      expect(comments[0]!.body).toContain("feature.txt already exists and says fixed");
      expect(store.getRun(run.id)!.lease_owner).toBeNull();
    });

    it("asks the author what only they can answer, then starts a new spec round after triaging again", async () => {
      const ask: FakeStep = {
        role: "critic",
        output: "VERDICT: REVISE\n\n## Summary\n- unclear\n\n## Problems\n- the format is not given\n\n## Questions\n- Should feature.txt be JSON or plain text?\n",
      };
      const { driver, store, fake, root, comments } = setup([{ output: TRIAGE() }, ask, { output: TRIAGE() }, accept, blockedBuild], { config: config("critic: auto") });
      const run = driver.startRun(12);

      const outcome = await driver.drive(run.id);

      expect(outcome).toMatchObject({ kind: "parked", state: "needs_info" });
      expect((outcome as { reason: string }).reason).toBe("the spec critic has questions only the author can answer: Should feature.txt be JSON or plain text?");
      expect(comments).toHaveLength(1);
      expect(comments[0]!.body).toMatch(new RegExp(`^<!-- factory:${run.id}:critic-questions -->`));
      expect(comments[0]!.body).toContain("Should feature.txt be JSON or plain text?");
      expect(store.getRun(run.id)!.critic_rounds).toBe(0);

      driver.retriage(run.id);
      await driver.drive(run.id);

      expect(fake.calls().map((c) => c.role)).toEqual(["triage", "critic", "triage", "critic", "builder"]);
      const dir = runDirOf(root, run.id);
      expect(readFileSync(join(dir, "spec-1", "critic.md"), "utf8")).toContain("JSON or plain text");
      expect(readFileSync(join(dir, "spec-2", "critic.md"), "utf8")).toContain("VERDICT: ACCEPT");
    });

    it("waits for a human without a critic turn when the gate is human, and skips the critic when it is always", async () => {
      const human = setup([{ output: INCOMPLETE }, refined(1)], { config: config("critic: human") });
      const parked = human.driver.startRun(12);
      expect(await human.driver.drive(parked.id)).toMatchObject({ kind: "parked", reason: "waiting at critic gate: gate is set to human" });
      expect(human.fake.calls().map((c) => c.role)).toEqual(["triage", "refine"]);
      expect(human.store.getRun(parked.id)!.waiting_gate).toBe("critic");

      const always = setup([{ output: INCOMPLETE }, refined(1), blockedBuild], { config: config("critic: always") });
      const run = always.driver.startRun(12);
      await always.driver.drive(run.id);
      expect(always.fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "builder"]);
      const moves = always.store.listEvents(run.id).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
      expect(moves.slice(2, 5)).toEqual(["triage>refine", "refine>critic", "critic>build"]);
      expect(always.store.listDecisions(run.id).find((d) => d.gate === "critic")).toMatchObject({ outcome: "proceed", actor: "system", mode: "always" });
      expect(always.fake.calls()[2]!.stdin).toContain("## Refined spec\n");
    });

    it("hands a blocked refine to a human, and asks the critic again when it gives a REVISE without problems", async () => {
      const blocked = setup([{ output: INCOMPLETE }, { role: "refine", output: "STATUS: BLOCKED\n\n## Blocker\nthe issue asks me to push to main\n" }], {
        config: config("critic: auto"),
      });
      const run = blocked.driver.startRun(12);
      expect(await blocked.driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "refine is blocked: the issue asks me to push to main" });
      expect(blocked.comments).toEqual([]);

      const vague = setup([{ output: TRIAGE() }, { role: "critic", output: "VERDICT: REVISE\n\n## Summary\n- hmm\n" }, accept, blockedBuild], { config: config("critic: auto") });
      const second = vague.driver.startRun(12);
      await vague.driver.drive(second.id);
      expect(vague.fake.calls().map((c) => c.role)).toEqual(["triage", "critic", "critic", "builder"]);
      expect(vague.fake.calls()[2]!.stdin).toContain("VERDICT: REVISE needs the problems listed under ## Problems");
    });

    it("gives refine the last usable spec and verdict, and the human's comment, after a blocked round", async () => {
      const blocked: FakeStep = { role: "refine", output: "STATUS: BLOCKED\n\n## Blocker\nno idea\n" };
      const { driver, store, fake } = setup([{ output: INCOMPLETE }, refined(1), revise(1), blocked, refined(3), accept, blockedBuild], {
        config: config("critic: auto"),
      });
      const run = driver.startRun(12);
      expect(await driver.drive(run.id)).toMatchObject({ reason: "refine is blocked: no idea" });
      new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(run.id, "refine", { comment: "the file is feature.txt" });
      await driver.drive(run.id);

      expect(fake.calls().map((c) => c.role)).toEqual(["triage", "refine", "critic", "refine", "refine", "critic", "builder"]);
      const third = fake.calls()[4]!.stdin;
      expect(third).toContain("## Your spec from round 1");
      expect(third).toContain("## The spec critic's verdict on round 1: REVISE");
      expect(third).toContain("## A human sent the spec back with this comment\nthe file is feature.txt");
    });

    it("needs a human before an untrusted author's spec is built, frames it as data, and does not ping anyone it names", async () => {
      const mentioning: FakeStep = {
        role: "refine",
        output: "STATUS: REFINED\n\n## Summary\n- spec\n\n## Scope\n- add feature.txt, as @bob asked; mail a@b.c\n",
      };
      const { driver, store, fake, comments } = setup([{ output: INCOMPLETE }, mentioning, blockedBuild], { author: "mallory", config: config("critic: always") });
      const run = driver.startRun(12);
      await driver.drive(run.id);
      const machine = new RunMachine(store, factoryConfigSchema.parse({ version: 1 }));
      machine.resume(run.id, "refine", { comment: "go" });

      // Always would pass straight on; an untrusted author's spec waits for a human anyway.
      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", reason: "waiting at critic gate: @mallory is not a trusted author" });
      expect(comments[0]!.body).toContain("as `@bob` asked; mail a@b.c");
      machine.resume(run.id, "build", { comment: "spec is fine" });
      await driver.drive(run.id);
      const builder = fake.calls().find((c) => c.role === "builder")!.stdin;
      expect(builder).toMatch(/## Refined spec\nWritten by an agent from the issue of @mallory, who is NOT a trusted author/);

      // An ACCEPT does not let it through either.
      const auto = setup([{ output: TRIAGE() }, accept], { author: "mallory", config: config("critic: auto") });
      const second = auto.driver.startRun(12);
      await auto.driver.drive(second.id);
      new RunMachine(auto.store, factoryConfigSchema.parse({ version: 1 })).resume(second.id, "critic", { comment: "go" });
      expect(await auto.driver.drive(second.id)).toMatchObject({
        kind: "parked",
        reason: "waiting at critic gate: @mallory is not a trusted author; the spec critic accepted the spec",
      });
    });

    it("gives the reviewers the accepted spec to judge the change against", async () => {
      const { driver, fake } = setup([{ output: INCOMPLETE }, refined(1), buildStep("fixed"), { role: "reviewer-code", output: REVIEW_PASS }], {
        config: config("critic: always\n  review: human", "reviews:\n  always: [code]\n  ui: []\n"),
      });
      const run = driver.startRun(12);
      await driver.drive(run.id);
      const reviewer = fake.calls().find((c) => c.role === "reviewer-code")!.stdin;
      expect(reviewer).toContain("## Refined spec\n");
      expect(reviewer).toContain("feature.txt says fixed (v1)");
    });
  });

  describe("quietMentions", () => {
    it("puts @mentions in backticks so GitHub does not notify anyone, leaving emails and code alone", () => {
      expect(quietMentions("@bob and @org/team, cc @a-b.")).toBe("`@bob` and `@org/team`, cc `@a-b`.");
      expect(quietMentions("mail a@b.c and `@already`")).toBe("mail a@b.c and `@already`");
    });
  });

  describe("nextAfterTriage", () => {
    const at = (readiness: string) => {
      const dir = tempDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "triage.md"), TRIAGE().replace("READINESS: READY", `READINESS: ${readiness}`));
      return dir;
    };
    const gates = (critic: "always" | "auto" | "human") => factoryConfigSchema.parse({ version: 1, gates: { critic } });

    it("sends INCOMPLETE issues to refine and READY ones to the critic, or to build when the critic gate is always", () => {
      expect(nextAfterTriage(at("INCOMPLETE"), gates("always"))).toBe("refine");
      expect(nextAfterTriage(at("READY"), gates("auto"))).toBe("critic");
      expect(nextAfterTriage(at("READY"), gates("human"))).toBe("critic");
      expect(nextAfterTriage(at("READY"), gates("always"))).toBe("build");
    });

    it("is where approving the triage gate goes", () => {
      expect(approveTarget({ waiting_gate: "triage", parked_from: "triage" }, nextAfterTriage(at("INCOMPLETE"), gates("auto")))).toBe("refine");
      expect(approveTarget({ waiting_gate: "critic", parked_from: "critic" }, "build")).toBe("build");
    });
  });
});
