import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { liveLeases, liveWorkers, runCommand, runPackageManager, ServiceError, takeUpgradeLock, type CommandRunner, type LiveLease, type LiveWorker } from "@factory/core";
import { CliError } from "../context.js";
import { CLI_FILE } from "../self.js";
import { plain, type Style } from "../style.js";

/** Set by the npm package's bundler (apps/cli/scripts/bundle.mjs); undefined everywhere else. */
declare const __FACTORY_BUNDLE__: true | undefined;

export const PACKAGE = "@tomek-i/software-factory";
export const RELEASES_URL = "https://github.com/tomek-i/software-factory/releases";

export type PackageManager = "npm" | "pnpm" | "yarn";

const MANAGERS: PackageManager[] = ["pnpm", "yarn", "npm"];

export interface Installer {
  manager: PackageManager;
  /** Its global node_modules folder, where the package lands. */
  modules: string;
}

export interface UpgradeDeps {
  /** The version running, as `factory --version` reports it. */
  installed: string;
  run?: CommandRunner;
  print?: (line: string) => void;
  /** Whether this is the bundled npm package rather than a source checkout. */
  bundled?: boolean;
  /** The running CLI's file: `dist/main.js` inside the installed package when bundled. */
  cliFile?: string;
  platform?: NodeJS.Platform;
  workers?: () => LiveWorker[];
  leases?: () => LiveLease[];
  /** Takes the upgrade lock, which keeps workers from starting; returns its release. */
  lock?: () => () => void;
  /** How to style output; plain unless the caller decided colour is on. */
  style?: Style;
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const LOOKUP_TIMEOUT_MS = 60_000;
const FROM_CHECKOUT = "Update it in the checkout instead: `git pull`, then `pnpm build`.";

/**
 * `factory upgrade`: install the latest published version with the package manager that installed
 * this one. With `check`, only say whether there is one. Returns the last line to print.
 */
export function runUpgrade(options: { check?: boolean }, deps: UpgradeDeps): string {
  const run = deps.run ?? runCommand;
  const tools = deps.run ?? runPackageManager;
  const print = deps.print ?? console.log;
  const platform = deps.platform ?? process.platform;
  const cliFile = deps.cliFile ?? CLI_FILE;
  const bundled = deps.bundled ?? typeof __FACTORY_BUNDLE__ !== "undefined";
  const style = deps.style ?? plain;

  // Checking is harmless from anywhere; only installing needs the published package.
  const installable = bundled && installedFromRegistry(cliFile);
  if (!options.check && !installable) {
    throw new CliError(["This factory runs from a source checkout (or a global link to one), not the published npm package.", FROM_CHECKOUT].join("\n"));
  }

  const latest = latestVersion(tools, platform);
  if (compareVersions(latest, deps.installed) <= 0) return style.success(`factory ${deps.installed} is up to date.`);
  const available = `${style.attention(`${latest} is available`)} (you have ${deps.installed}). Release notes: ${RELEASES_URL}`;
  if (options.check) {
    print(available);
    return installable ? style.hint("Install it with `factory upgrade`.") : `This factory runs from a source checkout. ${style.hint(FROM_CHECKOUT)}`;
  }

  const pkgDir = packageDir(cliFile);
  const installer = detectPackageManager(tools, pkgDir, platform);
  if (!installer) {
    // Installing with a guess would leave two copies, and the old one might stay first on PATH.
    throw new CliError(
      [
        `Could not tell which package manager installed this factory: no global folder of npm, pnpm or yarn holds ${pkgDir}.`,
        "Install it by hand with the one that did:",
        ...(["npm", "pnpm", "yarn"] as const).map((m) => `  ${installHint(m, latest)}`),
      ].join("\n"),
    );
  }

  // Taken before the checks below: a worker that starts after them sees it and refuses.
  const release = (deps.lock ?? takeLock)();
  try {
    refuseWhileWorking((deps.workers ?? liveWorkers)(), (deps.leases ?? (() => leasesFromChild(run, cliFile)))());

    const { manager, modules } = installer;
    print(available);
    print("Note: each project's database is migrated forward when this version first opens it, and an older factory can't read it afterwards.");
    print(`Installing ${PACKAGE}@${latest} with ${manager}...`);
    // Its output goes to the terminal, and it gets no timeout: killing cmd on Windows would leave
    // the package manager running, halfway through replacing the package.
    const result = tools(manager, installArgs(manager, latest), { cwd: homedir(), inherit: true, ...script(platform) });
    if (result.code !== 0) {
      throw new CliError(`${manager} could not install ${PACKAGE}@${latest} (exit code ${result.code}; its output is above).\nInstall it by hand: ${installHint(manager, latest)}`);
    }
    const now = installedVersion(modules);
    if (now !== latest) {
      throw new CliError(`${manager} finished, but ${join(modules, PACKAGE)} holds ${now === undefined ? "no readable package" : `version ${now}`} rather than ${latest}.\nInstall it by hand: ${installHint(manager, latest)}`);
    }
  } finally {
    release();
  }
  return style.success(`Upgraded factory to ${latest}.`);
}

function takeLock(): () => void {
  try {
    return takeUpgradeLock();
  } catch (err) {
    throw err instanceof ServiceError ? new CliError(err.message) : err;
  }
}

/** The version of the package in a global node_modules folder, or undefined when it can't be read. */
function installedVersion(modules: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(modules, PACKAGE, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/** The hidden `factory upgrade --list-leases`: the live leases as JSON, for leasesFromChild. */
export function runListLeases(): string {
  return JSON.stringify(liveLeases());
}

/** The newest published version, from the npm registry. */
export function latestVersion(run: CommandRunner, platform: NodeJS.Platform = process.platform): string {
  const result = run("npm", ["view", PACKAGE, "version"], { cwd: homedir(), timeoutMs: LOOKUP_TIMEOUT_MS, ...script(platform) });
  const version = result.stdout.trim();
  if (result.code !== 0) {
    throw new CliError(`Could not look up the latest version of ${PACKAGE} (\`npm view\` failed): ${(result.stderr || result.stdout).trim() || `exit code ${result.code}`}`);
  }
  // Checked before it goes anywhere near a command line, which on Windows passes through cmd.
  if (!VERSION.test(version)) throw new CliError(`Could not look up the latest version of ${PACKAGE}: npm answered "${version}".`);
  return version;
}

/** Semver order of two versions: negative when a is older, 0 when equal, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a);
  const pb = VERSION.exec(b);
  if (!pa || !pb) throw new CliError(`Not a version: "${pa ? b : a}"`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  // A release is newer than its prereleases.
  if (pa[4] === undefined || pb[4] === undefined) return (pa[4] === undefined ? 1 : 0) - (pb[4] === undefined ? 1 : 0);
  const xs = pa[4].split(".");
  const ys = pb[4].split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    // Numeric identifiers sort before alphanumeric ones.
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The package manager whose global folder holds the running package: the one to install the new
 * version with. Undefined when none does.
 */
export function detectPackageManager(run: CommandRunner, pkgDir: string, platform: NodeJS.Platform = process.platform): Installer | undefined {
  for (const manager of MANAGERS) {
    const result = run(manager, manager === "yarn" ? ["global", "dir"] : ["root", "-g"], { cwd: homedir(), timeoutMs: LOOKUP_TIMEOUT_MS, ...script(platform) });
    const root = result.stdout.trim().split(/\r?\n/).pop()?.trim();
    // Not installed, or no global folder yet.
    if (result.code !== 0 || !root) continue;
    // yarn names its global folder; the packages are in its node_modules.
    const modules = manager === "yarn" ? join(root, "node_modules") : root;
    if (inside(canonical(modules, platform), canonical(pkgDir, platform))) return { manager, modules };
  }
  return undefined;
}

/**
 * npm, pnpm and yarn are `.cmd` scripts on Windows, which Node only starts through a shell. The
 * arguments are fixed words and a checked version, so cmd has nothing to interpret.
 */
function script(platform: NodeJS.Platform): { windowsScript?: true } {
  return platform === "win32" ? { windowsScript: true } : {};
}

function installArgs(manager: PackageManager, version: string): string[] {
  const spec = `${PACKAGE}@${version}`;
  switch (manager) {
    case "npm":
      return ["install", "-g", spec];
    case "pnpm":
      return ["add", "-g", spec];
    case "yarn":
      return ["global", "add", spec];
  }
}

function installHint(manager: PackageManager, version: string): string {
  return [manager, ...installArgs(manager, version)].join(" ");
}

/** The installed package's folder: the bundle is its `dist/main.js`. */
function packageDir(cliFile: string): string {
  return resolve(dirname(cliFile), "..");
}

/**
 * A package installed from the registry sits in a `node_modules` folder; a global link to a
 * checkout resolves to the checkout itself, which `git pull` updates.
 */
function installedFromRegistry(cliFile: string): boolean {
  return packageDir(cliFile).split(/[\\/]/).includes("node_modules");
}

function refuseWhileWorking(workers: LiveWorker[], leases: LiveLease[]): void {
  const why = "Windows can't replace files a running factory has open, and swapping the engine under a run could break it.\nThis checks only for workers and runs being driven: close other factory commands (such as `factory logs -f`) yourself.";
  if (workers.length > 0) {
    throw new CliError(
      [
        `A \`factory work\` or \`factory serve\` is running (pid ${workers.map((w) => w.pid).join(", ")}).`,
        "Stop it with `factory stop` and wait for it to exit, then upgrade.",
        why,
        `If no such process is running, delete ${workers.map((w) => w.file).join(", ")}.`,
      ].join("\n"),
    );
  }
  if (leases.length > 0) {
    throw new CliError(
      [
        "Runs are being worked on:",
        ...leases.map((l) => `  ${l.project}${l.issue === null ? "" : ` #${l.issue}`} (run ${l.runId}, by ${l.owner})`),
        "Wait for them to stop, or interrupt them (Ctrl+C where they run), then upgrade.",
        why,
      ].join("\n"),
    );
  }
}

/**
 * Reading the projects' databases loads better-sqlite3's native module, which stays loaded until
 * the process exits, and Windows can't replace a loaded module. So the leases are read by a child
 * process, and this one never opens a database.
 */
function leasesFromChild(run: CommandRunner, cliFile: string): LiveLease[] {
  const result = run(process.execPath, [cliFile, "upgrade", "--list-leases"], { cwd: homedir(), timeoutMs: LOOKUP_TIMEOUT_MS });
  try {
    if (result.code !== 0) throw new Error(result.stderr.trim() || `exit code ${result.code}`);
    const leases: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(leases)) throw new Error(`expected a list of runs, got: ${result.stdout.slice(0, 200)}`);
    return leases as LiveLease[];
  } catch (err) {
    throw new CliError(`Could not check for runs in progress: ${(err as Error).message}`);
  }
}

function canonical(path: string, platform: NodeJS.Platform): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return platform === "win32" ? real.toLowerCase() : real;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
