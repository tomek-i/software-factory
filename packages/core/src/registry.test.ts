import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test/helpers.js";
import { factoryDataDir } from "./github/attachments.js";
import { listRegistered, registerProject, registryPath, sameProjectPath, unregisterProject } from "./registry.js";
import { ServiceError } from "./service/errors.js";

const here = dirname(fileURLToPath(import.meta.url));

function setup() {
  const file = join(tempDir("factory-registry-"), "projects.json");
  return { file, opts: { file } };
}

/** A folder that looks like an initialised repo: it has a `.factory/factory.db`. */
function initialisedRepo(): string {
  const root = tempDir("factory-repo-");
  mkdirSync(join(root, ".factory"));
  writeFileSync(join(root, ".factory", "factory.db"), "");
  return root;
}

describe("registryPath", () => {
  it("lives in the factory's data folder, which FACTORY_DATA_DIR moves", () => {
    expect(registryPath({ FACTORY_DATA_DIR: "/data" })).toBe(join("/data", "projects.json"));
    expect(factoryDataDir({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\U")).toBe(join("C:\\L", "software-factory"));
  });

  it("is a temp folder while testing, never the user's own list", () => {
    expect(process.env.FACTORY_DATA_DIR).toBeTruthy();
    expect(registryPath()).toBe(join(process.env.FACTORY_DATA_DIR!, "projects.json"));
  });
});

describe("registry", () => {
  it("is empty without a file", () => {
    expect(listRegistered(setup().opts)).toEqual([]);
  });

  it("adds a project once, and updates only its name", () => {
    const { file, opts } = setup();
    const root = initialisedRepo();

    expect(registerProject({ path: root, name: "demo" }, opts)).toBe("added");
    const before = readFileSync(file, "utf8");
    expect(registerProject({ path: root, name: "demo" }, opts)).toBe("unchanged");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(registerProject({ path: root, name: "renamed" }, opts)).toBe("updated");

    const listed = listRegistered(opts);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ path: root, name: "renamed", status: "ok" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
  });

  it("flags a project whose folder or database has gone", () => {
    const { opts } = setup();
    const gone = join(tempDir(), "deleted");
    const bare = tempDir("factory-repo-");
    registerProject({ path: gone, name: "gone" }, opts);
    registerProject({ path: bare, name: "bare" }, opts);

    expect(listRegistered(opts).map((p) => [p.name, p.status])).toEqual([
      ["gone", "missing_repo"],
      ["bare", "missing_db"],
    ]);
  });

  it("removes a project without touching the repo", () => {
    const { opts } = setup();
    const root = initialisedRepo();
    registerProject({ path: root, name: "demo" }, opts);

    expect(unregisterProject(root, opts)).toMatchObject({ path: root, name: "demo" });
    expect(listRegistered(opts)).toEqual([]);
    expect(existsSync(join(root, ".factory", "factory.db"))).toBe(true);
  });

  it("refuses to remove a project that is not listed", () => {
    const { opts } = setup();
    expect(() => unregisterProject("/nowhere", opts)).toThrow(ServiceError);
    expect(() => unregisterProject("/nowhere", opts)).toThrow(/Not in the project list/);
  });

  it("matches paths across separators, and across case on Windows", () => {
    expect(sameProjectPath("C:/Repos/Demo", "c:\\repos\\demo", "win32")).toBe(process.platform === "win32");
    expect(sameProjectPath("/a/b/../c", "/a/c", process.platform)).toBe(true);
    expect(sameProjectPath("/a/Demo", "/a/demo", "linux")).toBe(false);
  });

  it.runIf(process.platform === "win32")("finds a Windows repo however its path is spelled", () => {
    const { opts } = setup();
    const root = initialisedRepo();
    registerProject({ path: root.replace(/\\/g, "/"), name: "demo" }, opts);
    expect(registerProject({ path: root.toUpperCase(), name: "demo" }, opts)).toBe("unchanged");
    expect(unregisterProject(root, opts).name).toBe("demo");
  });

  it("refuses to rewrite a list it can't read, and leaves it as it was", () => {
    const { file, opts } = setup();
    writeFileSync(file, "{ not json");
    expect(() => listRegistered(opts)).toThrow(/is not valid/);
    expect(() => registerProject({ path: "/x", name: "x" }, opts)).toThrow(ServiceError);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(existsSync(`${file}.lock`)).toBe(false);

    writeFileSync(file, JSON.stringify({ version: 2, projects: [] }));
    expect(() => listRegistered(opts)).toThrow(/version/);
  });

  it("takes over a lock left by a process that died", () => {
    const { file, opts } = setup();
    const old = new Date(Date.now() - 60_000);
    writeFileSync(`${file}.lock`, "dead-holder");
    utimesSync(`${file}.lock`, old, old);

    expect(registerProject({ path: "/x", name: "x" }, opts)).toBe("added");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it("gives up on a lock another process holds, says which file, and leaves that lock alone", () => {
    const { file } = setup();
    writeFileSync(`${file}.lock`, "other-holder");
    const started = Date.now();

    expect(() => registerProject({ path: "/x", name: "x" }, { file, lockTimeoutMs: 300 })).toThrow(/locked by another factory process/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.lock`, "utf8")).toBe("other-holder");
  });

  it("keeps fields it doesn't know, so an older factory doesn't drop what a newer one wrote", () => {
    const { file, opts } = setup();
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ path: "/a", name: "a", added_at: "t", colour: "blue" }] }));
    registerProject({ path: "/b", name: "b" }, opts);
    expect(JSON.parse(readFileSync(file, "utf8")).projects[0]).toMatchObject({ path: "/a", colour: "blue" });
  });

  it("leaves no temp file behind", () => {
    const { file, opts } = setup();
    registerProject({ path: "/x", name: "x" }, opts);
    expect(readdirSync(dirname(file)).sort()).toEqual(["projects.json"]);
  });

  it("keeps every project when several processes register at once", async () => {
    const { file, opts } = setup();
    // Workspace packages resolve to their TypeScript sources, as in the tests themselves.
    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    const worker = join(here, "..", "test", "register-worker.ts");
    const paths = Array.from({ length: 8 }, (_, i) => join(tempDir(), `repo-${i}`));

    const start = String(Date.now() + 4_000);

    await Promise.all(paths.map((path) => promisify(execFile)(process.execPath, [tsx, "--conditions=source", worker, file, path, start])));

    const expected = paths.flatMap((path) => Array.from({ length: 5 }, (_, i) => `${path}-${i}`));
    expect(listRegistered(opts).map((p) => p.path).sort()).toEqual(expected.sort());
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 120_000);
});
