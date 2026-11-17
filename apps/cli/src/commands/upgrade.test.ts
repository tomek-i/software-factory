import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner, ExecResult } from "@factory/core";
import { CliError } from "../context.js";
import { compareVersions, detectPackageManager, packageManagerCommand, RELEASES_URL, runUpgrade, type UpgradeDeps } from "./upgrade.js";

const NPM_ROOT = join("/home/me/.npm-global/lib/node_modules");
const PNPM_ROOT = join("/home/me/.local/share/pnpm/global/5/node_modules");
const NPM_CLI = join(NPM_ROOT, "@tomek-i", "software-factory", "dist", "main.js");
const PNPM_CLI = join(PNPM_ROOT, ".pnpm", "@tomek-i+software-factory@0.5.0", "node_modules", "@tomek-i", "software-factory", "dist", "main.js");

/** A fake for npm, pnpm and yarn: answers by the command line, records every call. */
function fakeTools(answers: Record<string, Partial<ExecResult>>) {
  const calls: string[] = [];
  const run: CommandRunner = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const answer = answers[line] ?? (line.startsWith(process.execPath) ? answers["leases"] : undefined);
    return { code: 0, stdout: "", stderr: "", ...(answer ?? { code: -1, stderr: `${cmd}: not found` }) };
  };
  return { run, calls };
}

function setup(answers: Record<string, Partial<ExecResult>>, deps: Partial<UpgradeDeps> = {}) {
  const tools = fakeTools({
    "npm view @tomek-i/software-factory version": { stdout: "0.6.0\n" },
    "npm root -g": { stdout: NPM_ROOT },
    "npm install -g @tomek-i/software-factory@0.6.0": { stdout: "changed 1 package" },
    leases: { stdout: "[]" },
    ...answers,
  });
  const lines: string[] = [];
  const full: UpgradeDeps = {
    installed: "0.5.0",
    run: tools.run,
    print: (line) => lines.push(line),
    bundled: true,
    cliFile: NPM_CLI,
    platform: "linux",
    workers: () => [],
    ...deps,
  };
  return { ...tools, lines, deps: full };
}

describe("factory upgrade --check", () => {
  it("says the factory is up to date", () => {
    const t = setup({ "npm view @tomek-i/software-factory version": { stdout: "0.5.0" } });

    expect(runUpgrade({ check: true }, t.deps)).toBe("factory 0.5.0 is up to date.");
    expect(t.lines).toEqual([]);
  });

  it("says which version is available, with the releases page, and installs nothing", () => {
    const t = setup({});

    expect(runUpgrade({ check: true }, t.deps)).toBe("Install it with `factory upgrade`.");
    expect(t.lines).toEqual([`0.6.0 is available (you have 0.5.0). Release notes: ${RELEASES_URL}`]);
    expect(t.calls).toEqual(["npm view @tomek-i/software-factory version"]);
  });

  it("works from a source checkout too, since it changes nothing", () => {
    const t = setup({}, { bundled: false });

    expect(runUpgrade({ check: true }, t.deps)).toBe("Install it with `factory upgrade`.");
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
    const t = setup({});

    expect(runUpgrade({}, t.deps)).toBe("Upgraded factory to 0.6.0.");
    expect(t.calls).toContain("npm install -g @tomek-i/software-factory@0.6.0");
    expect(t.calls.at(-1)).toBe("npm install -g @tomek-i/software-factory@0.6.0");
    expect(t.lines).toEqual([
      `0.6.0 is available (you have 0.5.0). Release notes: ${RELEASES_URL}`,
      expect.stringMatching(/migrated forward .* an older factory can't read it afterwards/),
      "Installing @tomek-i/software-factory@0.6.0 with npm...",
    ]);
  });

  it("installs with pnpm when pnpm installed it", () => {
    const t = setup(
      { "pnpm root -g": { stdout: PNPM_ROOT }, "pnpm add -g @tomek-i/software-factory@0.6.0": {} },
      { cliFile: PNPM_CLI },
    );

    expect(runUpgrade({}, t.deps)).toBe("Upgraded factory to 0.6.0.");
    expect(t.calls.at(-1)).toBe("pnpm add -g @tomek-i/software-factory@0.6.0");
  });

  it("reads the leases in a child process, so this one never loads the database's native module", () => {
    const t = setup({});

    runUpgrade({}, t.deps);

    expect(t.calls).toContain(`${process.execPath} ${NPM_CLI} upgrade --list-leases`);
  });

  it("says what failed when the install fails", () => {
    const t = setup({ "npm install -g @tomek-i/software-factory@0.6.0": { code: 1, stderr: "EACCES: permission denied" } });

    expect(() => runUpgrade({}, t.deps)).toThrow(/npm could not install @tomek-i\/software-factory@0.6.0:\nEACCES: permission denied/);
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
    expect(t.calls.some((c) => c.includes("install"))).toBe(false);
  });

  it("refuses while a run holds a live lease", () => {
    const t = setup({}, { leases: () => [{ project: "shop", runId: "abc123", issue: 12, owner: "work-99-def" }] });

    expect(() => runUpgrade({}, t.deps)).toThrow(/Runs are being worked on:\n {2}shop #12 \(run abc123, by work-99-def\)[\s\S]*swapping the engine/);
    expect(t.calls.some((c) => c.includes("install"))).toBe(false);
  });

  it("refuses when it can't tell whether runs are in progress", () => {
    const t = setup({ leases: { code: 1, stderr: "database is locked" } });

    expect(() => runUpgrade({}, t.deps)).toThrow(/Could not check for runs in progress: database is locked/);
  });
});

describe("detectPackageManager", () => {
  it("falls back to npm when no global folder holds the package", () => {
    const { run } = fakeTools({});

    expect(detectPackageManager(run, join("/opt/factory"), "linux")).toBe("npm");
  });

  it("finds yarn's global folder", () => {
    const { run } = fakeTools({ "yarn global dir": { stdout: join("/home/me/.config/yarn/global") } });

    expect(detectPackageManager(run, join("/home/me/.config/yarn/global/node_modules/@tomek-i/software-factory"), "linux")).toBe("yarn");
  });

  it("runs the tools through cmd on Windows, where they are .cmd scripts", () => {
    expect(packageManagerCommand("pnpm", ["root", "-g"], "win32")).toEqual(["cmd", ["/d", "/c", "pnpm", "root", "-g"]]);
    expect(packageManagerCommand("pnpm", ["root", "-g"], "linux")).toEqual(["pnpm", ["root", "-g"]]);
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
