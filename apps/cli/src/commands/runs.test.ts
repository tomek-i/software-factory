import { describe, expect, it, vi } from "vitest";
import { runCommand, type CommandRunner } from "@factory/core";
import { GIT_TEST_TIMEOUT, reviewsPass } from "../../../../packages/core/test/helpers.js";
import { BUILD, ESC, fakeGh, github, setup, strip, TRIAGE } from "../../test/runs-setup.js";
import { createStyle, styleFor, type Style } from "../style.js";
import { runLogs, runRun, runStatus } from "./runs.js";

// Each test drives real git repos and fake claude processes; a busy machine makes them slow, not failing.
vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT });

describe("factory run", () => {
  it("refreshes a synced issue that is not queued yet, queues it, then runs it", async () => {
    const { run, printed } = setup([{ output: TRIAGE }], "triage: human");
    const gh = fakeGh({ number: 12, title: "Add the feature (edited)", state: "OPEN", author: "alice" });

    expect(await run("12", { run: gh })).toMatch(/waiting at the triage gate/);
    expect(printed[0]).toBe("Queued #12 Add the feature (edited)");
  });

  it("refuses an issue closed on GitHub since the last sync", async () => {
    const { run } = setup([]);
    const closed = fakeGh({ number: 12, title: "Add the feature", state: "CLOSED", author: "alice" });
    await expect(run("12", { run: closed })).rejects.toThrow(/#12 is closed/);
  });

  it("fetches an issue that was never synced, queues it and runs it", async () => {
    const { run, printed } = setup([{ output: TRIAGE }], "triage: human");
    const gh = fakeGh({ number: 30, title: "Brand new idea", state: "OPEN", author: "mallory" });

    expect(await run("30", { run: gh })).toMatch(/waiting at the triage gate/);
    expect(printed[0]).toBe("Queued #30 Brand new idea");
    // Running it yourself does not make a stranger's issue trusted.
    expect(printed[1]).toMatch(/not in trust\.authors/);
  });

  it("refuses closed issues and issues GitHub does not have", async () => {
    const { run } = setup([]);
    const closed = fakeGh({ number: 31, title: "Old", state: "CLOSED", author: "alice" });
    await expect(run("31", { run: closed })).rejects.toThrow(/#31 is closed/);
    const missing: CommandRunner = (cmd, args, options) =>
      cmd === "gh" ? { code: 1, stdout: "", stderr: "Could not resolve to an issue" } : runCommand(cmd, args, options);
    await expect(run("32", { run: missing })).rejects.toThrow(/Could not fetch issue #32/);
  });

  it("drives a queued issue to the review gate and says what to do next", async () => {
    const { run, queue, printed, dir } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();

    const message = await run();

    expect(message).toMatch(/waiting at the review gate/);
    expect(message).toMatch(/reviews: code PASS, security PASS, docs PASS/);
    expect(message).toMatch(/See it with: `factory show 12-[\w-]+`\./);
    expect(message).toContain("factory approve");
    expect(printed).toEqual(expect.arrayContaining(["-> triage: issue loaded", "-> build: triage approved"]));
    expect(printed.some((l) => l.startsWith("[gate] ok: passed"))).toBe(true);
    expect(printed.some((l) => l.startsWith("[builder] ok"))).toBe(true);

    const status = runStatus(dir, {}, { github });
    expect(status.split("\n")[0]).toMatch(/^RUN\s+ISSUE\s+STATE\s+ROUND\s+COST\s+WAITING$/);
    expect(status).toMatch(/12-[\w-]+\s+#12\s+needs_human\s+b1 r1\s+\$0\.21\s+review/);

    const logs = await runLogs(dir, "#12", {});
    expect(logs).toContain("intake -> triage  issue loaded");
    expect(logs).toMatch(/agent agent-\w+ builder ok \$0\.04/);
    expect(await runLogs(dir, "#12", { follow: true, intervalMs: 10 }, { print: () => undefined })).toMatch(/is needs_human/);
  });
});
describe("colour", () => {
  it("only styles the text: colour on, the plain text is unchanged; NO_COLOR or a pipe gives no escape codes", async () => {
    const colour = createStyle(true);
    const { queue, dir, printed, deps } = setup([{ output: TRIAGE }, BUILD, ...reviewsPass()]);
    queue();

    const message = await runRun(dir, ["12"], {}, { ...deps, style: colour });

    expect(message).toContain(ESC);
    expect(printed.join("\n")).toContain(ESC);
    const lines = printed.map(strip);
    expect(lines).toEqual(expect.arrayContaining(["-> triage: issue loaded", "-> build: triage approved"]));
    expect(lines.some((l) => /^Run 12-[\w-]+ \([a-z_]+\) for #12 Add the feature$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[gate\] ok: passed \(\d+\.\ds\)$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[builder\] ok \(\$0\.04\)$/.test(l))).toBe(true);
    expect(strip(message)).toMatch(
      /^Run 12-[\w-]+ is waiting at the review gate: .+\nSee it with: `factory show 12-[\w-]+`\.\nApprove with `factory approve 12-[\w-]+`, or reject with `factory reject 12-[\w-]+ -m "<why>"`\.$/,
    );

    // status keeps its columns aligned: stripping the codes gives exactly the plain table.
    const status = runStatus(dir, { all: true }, { github, style: colour });
    expect(status).toContain(ESC);
    expect(strip(status)).toBe(runStatus(dir, { all: true }, { github }));

    const logs = await runLogs(dir, "#12", {}, { style: colour });
    expect(logs).toContain(ESC);
    expect(strip(logs)).toBe(await runLogs(dir, "#12", {}));

    const follow = async (style?: Style) => {
      const out: string[] = [];
      const end = await runLogs(dir, "#12", { follow: true, intervalMs: 10 }, { print: (l) => out.push(l), style });
      return [...out, end];
    };
    const followed = await follow(colour);
    expect(followed.join("\n")).toContain(ESC);
    expect(followed.map(strip)).toEqual(await follow());

    for (const style of [styleFor({ isTTY: true }, { NO_COLOR: "1" }), styleFor({ isTTY: false }, {})]) {
      expect(runStatus(dir, { all: true }, { github, style })).not.toContain(ESC);
      expect(await runLogs(dir, "#12", {}, { style })).not.toContain(ESC);
      expect((await follow(style)).join("\n")).not.toContain(ESC);
    }
  });
});
