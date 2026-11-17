import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeClaude, tempDir, type FakeStep } from "../../test/helpers.js";
import { Store } from "../store/store.js";
import { createAgentRunner, type AgentRunOptions } from "./runner.js";
import { runTurn } from "./turn.js";

const TRIAGE = "DECISION: APPROVE\nREADINESS: READY\nRISK: LOW\nSURFACES: api\n\n## Summary\n- ok\n";

function setup(steps: FakeStep[]) {
  const fake = fakeClaude(steps);
  const store = new Store(":memory:");
  const project = store.upsertProject({ name: "demo", repo_path: "/repo" });
  const run = store.createRun({ project_id: project.id, title: "t", issue_number: 1 });
  const dir = tempDir();
  const outputFile = join(dir, "triage.md");
  writeFileSync(join(dir, "p.md"), "prompt");
  writeFileSync(join(dir, "s.json"), "{}");
  const agent: AgentRunOptions = {
    runId: run.id,
    role: "triage",
    model: "opus",
    cwd: dir,
    prompt: `Triage it.\n\nOutput file: \`${outputFile}\`\n`,
    systemPromptFile: join(dir, "p.md"),
    settingsFile: join(dir, "s.json"),
    logDir: join(dir, "logs"),
  };
  return { fake, outputFile, agent, runner: createAgentRunner({ store, env: fake.env }) };
}

describe("runTurn", () => {
  it("returns the parsed verdict", async () => {
    const { runner, agent, outputFile } = setup([{ output: TRIAGE }]);
    const turn = await runTurn({ run: runner, agent, kind: "triage", outputFile });
    expect(turn.status).toBe("ok");
    expect(turn.status === "ok" && turn.verdict.header.DECISION).toBe("APPROVE");
  });

  it("gives malformed output one retry in the same session, with the problems", async () => {
    const { runner, agent, outputFile, fake } = setup([{ output: "I approve!" }, { output: TRIAGE }]);
    const turn = await runTurn({ run: runner, agent, kind: "triage", outputFile });

    expect(turn.status).toBe("ok");
    const [first, retry] = fake.calls();
    expect(retry!.stdin).toContain("Your hand-over was not accepted");
    expect(retry!.stdin).toContain("header DECISION");
    const session = first!.argv[first!.argv.indexOf("--session-id") + 1];
    expect(retry!.argv).toEqual(expect.arrayContaining(["--resume", session]));
  });

  it("escalates when the retry is still invalid", async () => {
    const { runner, agent, outputFile, fake } = setup([{ output: "nope" }, {}]);
    const turn = await runTurn({ run: runner, agent, kind: "triage", outputFile });
    expect(turn.status).toBe("invalid");
    expect(turn.status === "invalid" && turn.problems.join()).toContain("was not written");
    expect(fake.calls()).toHaveLength(2);
  });

  it("does not accept a stale output file from an earlier round", async () => {
    const { runner, agent, outputFile } = setup([{}, {}]);
    writeFileSync(outputFile, TRIAGE);
    const turn = await runTurn({ run: runner, agent, kind: "triage", outputFile });
    expect(turn.status).toBe("invalid");
  });

  it("applies extra validation and retries on its problems", async () => {
    const { runner, agent, outputFile, fake } = setup([{ output: TRIAGE }, { output: TRIAGE }]);
    const turn = await runTurn({ run: runner, agent, kind: "triage", outputFile, validate: () => ["branch is not pushed"] });
    expect(turn.status).toBe("invalid");
    expect(fake.calls()[1]!.stdin).toContain("- branch is not pushed");
  });

  it("does not retry when the agent itself failed", async () => {
    const { runner, agent, outputFile, fake } = setup([{ stream: "error_max_turns" }]);
    const turn = await runTurn({ run: runner, agent, kind: "triage", outputFile });
    expect(turn.status).toBe("failed");
    expect(fake.calls()).toHaveLength(1);
  });
});
