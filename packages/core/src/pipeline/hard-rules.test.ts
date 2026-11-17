import { factoryConfigSchema } from "@factory/shared";
import { describe, expect, it } from "vitest";
import { hardRuleHits, isManifest } from "./hard-rules.js";

describe("hard rules on dependencies", () => {
  it("reads only the manifests among the changed files, since only they can declare dependencies", () => {
    const reads: string[] = [];
    const hits = hardRuleHits({
      files: [
        { path: "src/app.ts", status: "M" },
        { path: "docs/guide.md", status: "A" },
        { path: "packages/web/package.json", status: "M" },
      ],
      config: factoryConfigSchema.parse({ version: 1 }),
      read: (rev, path) => {
        reads.push(`${rev}:${path}`);
        return rev === "head" ? '{"dependencies":{"left-pad":"1.0.0"}}' : '{"dependencies":{}}';
      },
      scope: "",
    });

    expect(reads).toEqual(["head:packages/web/package.json", "base:packages/web/package.json"]);
    expect(hits).toContain("new dependency in packages/web/package.json: left-pad");
  });

  it("knows every manifest kind it reads dependencies from", () => {
    for (const path of ["package.json", "a/App.csproj", "Directory.Packages.props", "packages.config", "requirements-dev.txt", "constraints.txt", "pyproject.toml", "Pipfile", "go.mod"]) {
      expect(isManifest(path), path).toBe(true);
    }
    for (const path of ["src/index.ts", "README.md", "package-lock.json", "go.sum", "requirements.md"]) {
      expect(isManifest(path), path).toBe(false);
    }
  });
});
