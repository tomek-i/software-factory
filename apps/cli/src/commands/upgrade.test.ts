import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { registerWorker, takeUpgradeLock, upgradeLockPath, type CommandRunner, type ExecResult } from "@factory/core";
import { CliError } from "../context.js";
import { createStyle } from "../style.js";
import { compareVersions, detectPackageManager, PACKAGE, RELEASES_URL, runUpgrade, type UpgradeDeps } from "./upgrade.js";

/** Global folders of npm, pnpm and yarn, each holding the package at version 0.5.0 like a real install. */
function globalFolders() {
  const home = mkdtempSync(join(tmpdir(), "factory-upgrade-"));
  const npm = join(home, "npm", "node_modules");
  const pnpm = join(home, "pnpm", "global", "5", "node_modules");
  const yarn = join(home, "yarn", "global");
  const install = (modules: string, version: string, real = join(modules, PACKAGE)) => {
    mkdirSync(join(real, "dist"), { recursive: true });
    writeFileSync(join(real, "package.json"), JSON.stringify({ name: PACKAGE, version }));
    return join(real, "dist", "main.js");
  };
  return {
    npm,
    pnpm,
    yarn,
    install,
    npmCli: install(npm, "0.5.0"),
    pnpmCli: install(pnpm, "0.5.0", join(pnpm, ".pnpm", "@tomek-i+software-factory@0.5.0", "node_modules", PACKAGE)),
  };
}

/** A fake for npm, pnpm and yarn: answers by the command line, records every call. */
function fakeTools(answers: Answers) {
  const calls: string[] = [];
  const run: CommandRunner = (cmd, args, opts) => {
    // As runCommand starts it: through cmd when asked.
    const line = [...(opts.windowsScript ? ["cmd", "/d", "/c"] : []), cmd, ...args].join(" ");
    calls.push(line);
    const answer = answers[line] ?? (line.startsWith(process.execPath) ? answers["leases"] : undefined);
    const result = typeof answer === "function" ? answer() : answer;
    return { code: 0, stdout: "", stderr: "", ...(result ?? { code: -1, stderr: `${cmd}: not found` }) };
  };
  return { run, calls };
}

type Answers = Record<string, Partial<ExecResult> | (() => Partial<ExecResult>)>;
type Folders = ReturnType<typeof globalFolders>;

/** answers and deps may depend on the global folders, which each setup creates afresh. */
function setup(answers: Answers | ((f: Folders) => Answers) = {}, deps: Partial<UpgradeDeps> | ((f: Folders) => Partial<UpgradeDeps>) = {}) {
  const folders = globalFolders();
  const tools = fakeTools({
    "npm view @tomek-i/software-factory version": { stdout: "0.6.0\n" },
    "npm root -g": { stdout: folders.npm },
    "npm install -g @tomek-i/software-factory@0.6.0": () => (folders.install(folders.npm, "0.6.0"), {}),
    leases: { stdout: "[]" },
    ...(typeof answers === "function" ? answers(folders) : answers),
  });
  const lines: string[] = [];
  const full: UpgradeDeps = {
    installed: "0.5.0",
    run: tools.run,
    print: (line) => lines.push(line),
    bundled: true,
    cliFile: folders.npmCli,
    platform: "linux",
    workers: () => [],
    ...(typeof deps === "function" ? deps(folders) : deps),
  };
  return { ...tools, folders, lines, deps: full };
}

const installs = (calls: string[]) => calls.filter((c) => / (install|add) /.test(c));

describe("factory upgrade --check", () => {
  it("says the factory is up to date", () => {
    const t = setup({ "npm view @tomek-i/software-factory version": { stdout: "0.5.0" } });

    expect(runUpgrade({ check: true }, t.deps)).toBe("factory 0.5.0 is up to date.");
    expect(t.lines).toEqual([]);
  });

  it("says which version is available, with the releases page, and installs nothing", () => {
    const t = setup();

    expect(runUpgrade({ check: true }, t.deps)).toBe("Install it with `factory upgrade`.");
    expect(t.lines).toEqual([`0.6.0 is available (you have 0.5.0). Release notes: ${RELEASES_URL}`]);
    expect(t.calls).toEqual(["npm view @tomek-i/software-factory version"]);
  });

  it("colours up to date as good, a newer version as attention and the next step as a hint", () => {
    const colour = createStyle(true);
    const current = setup({ "npm view @tomek-i/software-factory version": { stdout: "0.5.0" } }, { style: colour });
    expect(runUpgrade({ check: true }, current.deps)).toBe(colour.success("factory 0.5.0 is up to date."));

    const t = setup({}, { style: colour });
    const hint = runUpgrade({ check: true }, t.deps);
    expect(hint).toBe(colour.hint("Install it with `factory upgrade`."));
    expect(t.lines).toEqual([`${colour.attention("0.6.0 is available")} (you have 0.5.0). Release notes: ${RELEASES_URL}`]);
    expect([hint, ...t.lines].map((line) => stripVTControlCharacters(line))).toEqual([
      "Install it with `factory upgrade`.",
      `0.6.0 is available (you have 0.5.0). Release notes: ${RELEASES_URL}`,
    ]);
  });

  it("works from a source checkout too, and says to pull and rebuild", () => {
    const t = setup({}, { bundled: false });

    expect(runUpgrade({ check: true }, t.deps)).toMatch(/source checkout.*`git pull`, then `pnpm build`/);
  });

  it("explains a registry lookup that fails", () => {
    const t = setup({ "npm view @tomek-i/software-factory version": { code: 1, stderr: "npm error code ENOTFOUND" } });

    expect(() => runUpgrade({ check: true }, t.deps)).toThrow(/Could not look up the latest version of @tomek-i\/software-factory \(`npm view` failed\): npm error code ENOTFOUND/);
  });

  it("refuses an answer from the registry that is not a version", () => {
    const t = setup({ "npm view @tomek-i/software-factory version": { stdout: "1.0.0 & calc" } });

    expect(() => runUpgrade({ check: true }, t.deps)).toThrow(/npm answered "1.0.0 & calc"/);
  });
});

describe("factory upgrade", () => {
  it("installs nothing when up to date", () => {
    const t = setup({ "npm view @tomek-i/software-factory version": { stdout: "0.5.0" } });

    expect(runUpgrade({}, t.deps)).toBe("factory 0.5.0 is up to date.");
    expect(t.calls).toEqual(["npm view @tomek-i/software-factory version"]);
  });

  it("installs the newer version with npm, warning about migrations first", () => {
    const t = setup();

    expect(runUpgrade({}, t.deps)).toBe("Upgraded factory to 0.6.0.");
    expect(installs(t.calls)).toEqual(["npm install -g @tomek-i/software-factory@0.6.0"]);
    expect(t.lines).toEqual([
      `0.6.0 is available (you have 0.5.0). Release notes: ${RELEASES_URL}`,
      expect.stringMatching(/migrated forward .* an older factory can't read it afterwards/),
      "Installing @tomek-i/software-factory@0.6.0 with npm...",
    ]);
  });

  it("shows the install's output and gives it no timeout", () => {
    const t = setup();
    const options: unknown[] = [];
    const run: CommandRunner = (cmd, args, opts) => {
      if (args.includes("install")) options.push(opts);
      return t.run(cmd, args, opts);
    };

    runUpgrade({}, { ...t.deps, run });

    expect(options).toEqual([{ cwd: expect.any(String), inherit: true }]);
  });

  it("installs with pnpm when pnpm installed it", () => {
    const t = setup(
      (f) => ({
        "pnpm root -g": { stdout: f.pnpm },
        "pnpm add -g @tomek-i/software-factory@0.6.0": () => (f.install(f.pnpm, "0.6.0"), {}),
      }),
      (f) => ({ cliFile: f.pnpmCli }),
    );

    expect(runUpgrade({}, t.deps)).toBe("Upgraded factory to 0.6.0.");
    expect(installs(t.calls)).toEqual(["pnpm add -g @tomek-i/software-factory@0.6.0"]);
  });

  it("goes through cmd on Windows, where the package managers are .cmd scripts", () => {
    const t = setup(
      (f) => ({
        "cmd /d /c npm view @tomek-i/software-factory version": { stdout: "0.6.0" },
        "cmd /d /c npm root -g": { stdout: f.npm },
        "cmd /d /c npm install -g @tomek-i/software-factory@0.6.0": () => (f.install(f.npm, "0.6.0"), {}),
      }),
      { platform: "win32" },
    );

    expect(runUpgrade({}, t.deps)).toBe("Upgraded factory to 0.6.0.");
    expect(installs(t.calls)).toEqual(["cmd /d /c npm install -g @tomek-i/software-factory@0.6.0"]);
  });

  it("refuses with the manual commands when no package manager's global folder holds it", () => {
    const t = setup({ "npm root -g": { stdout: join(tmpdir(), "elsewhere", "node_modules") } });

    expect(() => runUpgrade({}, t.deps)).toThrow(
      /Could not tell which package manager installed this factory[\s\S]*npm install -g @tomek-i\/software-factory@0.6.0[\s\S]*pnpm add -g[\s\S]*yarn global add/,
    );
    expect(installs(t.calls)).toEqual([]);
  });

  it("fails when the install leaves another version in place", () => {
    const t = setup({ "npm install -g @tomek-i/software-factory@0.6.0": {} });

    expect(() => runUpgrade({}, t.deps)).toThrow(/npm finished, but .* holds version 0.5.0 rather than 0.6.0/);
  });

  it("reads the leases in a child process, so this one never loads the database's native module", () => {
    const t = setup();

    runUpgrade({}, t.deps);

    expect(t.calls).toContain(`${process.execPath} ${t.folders.npmCli} upgrade --list-leases`);
  });

  it("says what failed when the install fails", () => {
    const t = setup({ "npm install -g @tomek-i/software-factory@0.6.0": { code: 1 } });

    expect(() => runUpgrade({}, t.deps)).toThrow(/npm could not install @tomek-i\/software-factory@0.6.0 \(exit code 1; its output is above\)/);
  });

  it("refuses from a source checkout", () => {
    const t = setup({}, { bundled: false });

    expect(() => runUpgrade({}, t.deps)).toThrow(/source checkout[\s\S]*`git pull`, then `pnpm build`/);
    expect(t.calls).toEqual([]);
  });

  it("refuses a bundle linked from a checkout", () => {
    const t = setup({}, { cliFile: join("/home/me/src/software-factory/apps/cli/dist/main.js") });

    expect(() => runUpgrade({}, t.deps)).toThrow(CliError);
    expect(t.calls).toEqual([]);
  });

  it("refuses while a worker runs, and says why", () => {
    const t = setup({}, { workers: () => [{ pid: 4242, file: "/data/workers/4242-abc.json" }] });

    expect(() => runUpgrade({}, t.deps)).toThrow(/`factory serve` is running \(pid 4242\)[\s\S]*`factory stop`[\s\S]*Windows can't replace files/);
    expect(installs(t.calls)).toEqual([]);
  });

  it("refuses while a run holds a live lease", () => {
    const t = setup({}, { leases: () => [{ project: "shop", runId: "abc123", issue: 12, owner: "work-99-def" }] });

    expect(() => runUpgrade({}, t.deps)).toThrow(/Runs are being worked on:\n {2}shop #12 \(run abc123, by work-99-def\)[\s\S]*swapping the engine/);
    expect(installs(t.calls)).toEqual([]);
  });

  it("refuses when it can't tell whether runs are in progress", () => {
    const t = setup({ leases: { code: 1, stderr: "database is locked" } });

    expect(() => runUpgrade({}, t.deps)).toThrow(/Could not check for runs in progress: database is locked/);
  });

  it("refuses when the lease check answers something other than a list", () => {
    const t = setup({ leases: { stdout: '{"runs":[]}' } });

    expect(() => runUpgrade({}, t.deps)).toThrow(/Could not check for runs in progress: expected a list of runs/);
    expect(installs(t.calls)).toEqual([]);
  });

  it("holds the upgrade lock while it checks and installs, so no worker starts, and gives it back", () => {
    let refused: unknown;
    const t = setup({
      "npm install -g @tomek-i/software-factory@0.6.0": () => {
        try {
          registerWorker(join(tmpdir(), `factory-workers-${process.pid}`), process.pid + 1, upgradeLockPath());
        } catch (err) {
          refused = err;
        }
        return {};
      },
    });
    // The lock is this process's, which a worker in the same process would ignore: pretend it's another's.
    t.deps.lock = () => takeUpgradeLock(upgradeLockPath(), process.ppid);

    expect(() => runUpgrade({}, t.deps)).toThrow(/holds version 0.5.0/);
    expect((refused as Error | undefined)?.message).toMatch(/`factory upgrade` is replacing the factory/);
    expect(existsSync(upgradeLockPath())).toBe(false);
  });

  it("refuses while another upgrade holds the lock", () => {
    const t = setup();
    const release = takeUpgradeLock(upgradeLockPath(), process.ppid);
    try {
      expect(() => runUpgrade({}, t.deps)).toThrow(/Another `factory upgrade` is running/);
    } finally {
      release();
    }
  });
});

describe("detectPackageManager", () => {
  it("finds yarn's global folder", () => {
    const { yarn, install } = globalFolders();
    const cli = install(join(yarn, "node_modules"), "0.5.0");
    const { run } = fakeTools({ "yarn global dir": { stdout: yarn } });

    expect(detectPackageManager(run, join(cli, "..", ".."), "linux")).toEqual({ manager: "yarn", modules: join(yarn, "node_modules") });
  });

  it("finds none when no global folder holds the package", () => {
    const { run } = fakeTools({});

    expect(detectPackageManager(run, join("/opt/factory"), "linux")).toBeUndefined();
  });

  it("runs the tools through cmd on Windows only", () => {
    const win = fakeTools({});
    detectPackageManager(win.run, join("/opt/factory"), "win32");
    expect(win.calls).toEqual(["cmd /d /c pnpm root -g", "cmd /d /c yarn global dir", "cmd /d /c npm root -g"]);
    const linux = fakeTools({});
    detectPackageManager(linux.run, join("/opt/factory"), "linux");
    expect(linux.calls).toEqual(["pnpm root -g", "yarn global dir", "npm root -g"]);
  });
});

describe("compareVersions", () => {
  it("orders versions as semver does", () => {
    expect(compareVersions("0.6.0", "0.5.0")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta.1")).toBeLessThan(0);
  });
});
