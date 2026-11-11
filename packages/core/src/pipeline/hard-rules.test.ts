import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { factoryConfigSchema } from "@factory/shared";
import { git, repoWithRemote } from "../../test/helpers.js";
import { declaredDependencies, diffHardRuleHits, globToRegExp } from "./hard-rules.js";

const config = (extra: object = {}) => factoryConfigSchema.parse({ version: 1, ...extra });

/** A repo whose main has `base`, with a branch that applies `change` (null deletes a file) in one commit. */
function diff(base: Record<string, string>, change: Record<string, string | null>, options: { scope?: string; paths?: string[]; tamper?: (root: string) => void } = {}) {
  const { root } = repoWithRemote({ "README.md": "# demo\n", ...base });
  git(root, "checkout", "-qb", "factory/1-change");
  for (const [path, content] of Object.entries(change)) {
    const target = join(root, path);
    if (content === null) rmSync(target);
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
  git(root, "add", "-A");
  git(root, "commit", "-qm", "change");
  options.tamper?.(root);
  return diffHardRuleHits({
    cwd: root,
    defaultBranch: "main",
    config: config({ hard_rules: { paths: options.paths ?? [] } }),
    scope: options.scope ?? "Add a feature",
  });
}

describe("hard rules on a real diff", () => {
  it("finds nothing in an ordinary change", () => {
    expect(diff({ "src/app.ts": "a\n" }, { "src/app.ts": "b\n", "src/new.ts": "c\n" })).toEqual([]);
  });

  it("flags protected paths, built in and configured", () => {
    expect(diff({}, { "infra/main.tf": "x\n", "src/auth/login.ts": "x\n", "docs/legal/terms.md": "x\n" }, { paths: ["docs/legal/**"] })).toEqual([
      "protected path (docs/legal/**): docs/legal/terms.md",
      "protected path (infra/**): infra/main.tf",
      "protected path (**/auth/**): src/auth/login.ts",
    ]);
    expect(diff({}, { ".github/workflows/ci.yml": "on: push\n" })).toEqual(["protected path (.github/workflows/**): .github/workflows/ci.yml"]);
  });

  it("flags a new npm dependency but not a version bump or a script change", () => {
    const before = JSON.stringify({ scripts: { test: "vitest" }, dependencies: { zod: "^3.0.0" } });
    const bump = JSON.stringify({ scripts: { test: "vitest run" }, dependencies: { zod: "^3.1.0" } });
    expect(diff({ "package.json": before }, { "package.json": bump })).toEqual([]);
    const added = JSON.stringify({ dependencies: { zod: "^3.0.0" }, devDependencies: { "left-pad": "1.0.0" } });
    expect(diff({ "package.json": before }, { "package.json": added })).toEqual(["new dependency in package.json: left-pad"]);
  });

  it("flags new dependencies for NuGet, pip, Go, and a brand-new lockfile", () => {
    const csproj = (refs: string) => `<Project><ItemGroup>${refs}</ItemGroup></Project>`;
    expect(
      diff(
        { "src/App.csproj": csproj('<PackageReference Include="Serilog" Version="3.0.0" />') },
        { "src/App.csproj": csproj('<PackageReference Include="Serilog" Version="3.1.0" /><PackageReference Include="Newtonsoft.Json" Version="13.0.0" />') },
      ),
    ).toEqual(["new dependency in src/App.csproj: newtonsoft.json"]);
    expect(diff({ "requirements.txt": "requests==2.0\n" }, { "requirements.txt": "requests==2.1\n# comment\nflask>=3\n" })).toEqual([
      "new dependency in requirements.txt: flask",
    ]);
    expect(
      diff(
        { "pyproject.toml": '[project]\nname = "app"\ndependencies = [\n  "httpx>=0.27",\n]\n' },
        { "pyproject.toml": '[project]\nname = "app"\ndependencies = [\n  "httpx>=0.28",\n  "rich",\n]\n\n[tool.poetry.dependencies]\npython = "^3.12"\ntyper = "*"\n' },
      ),
    ).toEqual(["new dependency in pyproject.toml: rich, typer"]);
    expect(
      diff({ "go.mod": "module x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n" }, { "go.mod": "module x\n\nrequire (\n\tgithub.com/a/b v1.1.0\n\tgithub.com/c/d v0.1.0\n)\n" }),
    ).toEqual(["new dependency in go.mod: github.com/c/d"]);
    expect(diff({}, { "yarn.lock": "# yarn\n" })).toEqual(["lockfile added: yarn.lock"]);
  });

  it("flags secret and env files", () => {
    expect(diff({}, { ".env.local": "TOKEN=x\n", "certs/server.pem": "x\n", "src/config.ts": "x\n" })).toEqual([
      "secret or env file changed: .env.local",
      "secret or env file changed: certs/server.pem",
    ]);
  });

  it("flags deleting a file the issue does not mention, including a rename", () => {
    const base = { "src/old.ts": "a\n", "src/keep.ts": "b\n", "src/moved.ts": "c\n" };
    expect(diff(base, { "src/old.ts": null, "src/moved.ts": null, "src/renamed.ts": "c\n" }, { scope: "Remove src/old.ts, it is dead code" })).toEqual([
      "deletes a file the issue does not name by its path: src/moved.ts",
    ]);
  });

  it("does not count a longer name or a bare file name as naming the deleted path", () => {
    const base = { "src/a.ts": "a\n", "src/index.ts": "b\n" };
    expect(diff(base, { "src/a.ts": null, "src/index.ts": null }, { scope: "See src/a.tsx and data.ts; update index.ts" })).toEqual([
      "deletes a file the issue does not name by its path: src/a.ts",
      "deletes a file the issue does not name by its path: src/index.ts",
    ]);
  });

  it("is not fooled by a builder that moves origin/main or plants a replace ref", () => {
    const moveOrigin = (root: string) => git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(diff({}, { "infra/main.tf": "x\n" }, { tamper: moveOrigin })).toEqual(["protected path (infra/**): infra/main.tf"]);
    const replace = (root: string) => git(root, "replace", "-f", "HEAD", "HEAD~1");
    expect(diff({}, { "infra/main.tf": "x\n" }, { tamper: replace })).toEqual(["protected path (infra/**): infra/main.tf"]);
  });

  it("flags a dependency whose source changes, and overrides", () => {
    const before = JSON.stringify({ dependencies: { zod: "^3.0.0" } });
    const swapped = JSON.stringify({ dependencies: { zod: "npm:evil@1.0.0" }, overrides: { lodash: "github:x/lodash" } });
    expect(diff({ "package.json": before }, { "package.json": swapped })).toEqual([
      "new dependency in package.json: overrides>lodash",
      "dependency source changed in package.json: zod (npm:evil@1.0.0)",
    ]);
    expect(diff({ "requirements.txt": "requests==2.0\n" }, { "requirements.txt": "requests @ git+https://x/requests\n-r extra.txt\n" })).toEqual([
      "new dependency in requirements.txt: -r extra.txt",
      "dependency source changed in requirements.txt: requests (@ git+https://x/requests)",
    ]);
    expect(
      diff({ "go.mod": "module x\n\nrequire github.com/a/b v1.0.0\n" }, { "go.mod": "module x\n\nrequire github.com/a/b v1.0.0\nreplace github.com/a/b => github.com/evil/b v1.0.0\n" }),
    ).toEqual(["new dependency in go.mod: replace github.com/a/b"]);
  });

  it("reads pyproject arrays with brackets inside strings, optional-dependencies and dependency-groups", () => {
    const after = [
      "[project]",
      "dependencies = [",
      '  "requests[socks]>=2",',
      '  "evil",',
      "]",
      "[project.optional-dependencies]",
      'dev = ["pytest", "sneaky[extra]"]',
      "[dependency-groups]",
      'lint = ["ruff"]',
    ].join("\n");
    expect(diff({ "pyproject.toml": '[project]\nname = "app"\n' }, { "pyproject.toml": after })).toEqual([
      "new dependency in pyproject.toml: evil, pytest, requests, ruff, sneaky",
    ]);
  });

  it("reads NuGet Update= and single quotes, and flags package source config", () => {
    expect(diff({ "App.csproj": "<Project />" }, { "App.csproj": "<Project><PackageReference Update='Evil.Pkg' /></Project>" })).toEqual([
      "new dependency in App.csproj: evil.pkg",
    ]);
    expect(diff({}, { "NuGet.Config": "<configuration />", "Directory.Build.props": "<Project />", ".gitmodules": "" })).toEqual([
      "dependency config changed: .gitmodules",
      "dependency config changed: Directory.Build.props",
      "dependency config changed: NuGet.Config",
    ]);
  });
});

describe("globToRegExp", () => {
  it("matches like the documented globs", () => {
    expect(globToRegExp("**/auth/**").test("auth/x.ts")).toBe(true);
    expect(globToRegExp("**/auth/**").test("a/b/auth/c/d.ts")).toBe(true);
    expect(globToRegExp("**/auth/**").test("oauth/x.ts")).toBe(false);
    expect(globToRegExp("infra/*").test("infra/a/b.tf")).toBe(false);
    expect(globToRegExp("infra/**").test("infra/a/b.tf")).toBe(true);
    expect(globToRegExp("*.lock").test("yarn.lock")).toBe(true);
  });
});

describe("declaredDependencies", () => {
  it("ignores files that are not manifests", () => {
    expect(declaredDependencies("src/index.ts", "import x from 'y'")).toBeUndefined();
  });
});
