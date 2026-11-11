import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface DetectedCheck {
  name: string;
  run: string;
}

export interface Detection {
  stacks: string[];
  checks: DetectedCheck[];
  appStart?: string;
  projectName: string;
}

const CHECK_ORDER = ["lint", "typecheck", "build", "test"];

function sortChecks(checks: DetectedCheck[]): DetectedCheck[] {
  // "build-dotnet" sorts with "build"; Array.sort is stable so the first stack stays first.
  const rank = (name: string) => CHECK_ORDER.indexOf(name.split("-")[0]!);
  return [...checks].sort((a, b) => rank(a.name) - rank(b.name));
}

function detectNode(root: string): Partial<Detection> | undefined {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) return undefined;

  let manifest: { name?: string; scripts?: Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { stacks: ["node"] };
  }
  const has = (f: string) => existsSync(join(root, f));
  const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lock") || has("bun.lockb") ? "bun" : "npm";
  const scripts = manifest.scripts ?? {};

  // Map the check we want to the first script name the project actually uses for it.
  const aliases: Record<string, string[]> = {
    lint: ["lint"],
    typecheck: ["typecheck", "type-check", "check-types", "tsc"],
    build: ["build"],
    test: ["test"],
  };
  const checks: DetectedCheck[] = [];
  for (const [name, candidates] of Object.entries(aliases)) {
    const script = candidates.find((c) => scripts[c]);
    if (script) checks.push({ name, run: `${pm} run ${script}` });
  }
  const startScript = ["dev", "start"].find((s) => scripts[s]);

  return {
    stacks: ["node"],
    checks,
    appStart: startScript ? `${pm} run ${startScript}` : undefined,
    projectName: manifest.name,
  };
}

function detectDotnet(root: string): Partial<Detection> | undefined {
  const files = readdirSync(root);
  if (!files.some((f) => f.endsWith(".sln") || f.endsWith(".slnx") || f.endsWith(".csproj"))) return undefined;
  return {
    stacks: ["dotnet"],
    checks: [
      { name: "build", run: "dotnet build" },
      { name: "test", run: "dotnet test --no-build" },
    ],
  };
}

function detectPython(root: string): Partial<Detection> | undefined {
  const pyproject = join(root, "pyproject.toml");
  if (!existsSync(pyproject) && !existsSync(join(root, "requirements.txt"))) return undefined;
  const text = existsSync(pyproject) ? readFileSync(pyproject, "utf8") : "";
  const checks: DetectedCheck[] = [];
  if (/\bruff\b/.test(text)) checks.push({ name: "lint", run: "ruff check ." });
  if (/\bmypy\b/.test(text)) checks.push({ name: "typecheck", run: "mypy ." });
  checks.push({ name: "test", run: "pytest" });
  return { stacks: ["python"], checks };
}

function detectGo(root: string): Partial<Detection> | undefined {
  if (!existsSync(join(root, "go.mod"))) return undefined;
  return {
    stacks: ["go"],
    checks: [
      { name: "lint", run: "go vet ./..." },
      { name: "build", run: "go build ./..." },
      { name: "test", run: "go test ./..." },
    ],
  };
}

/** Best-effort guess at a repo's stack and check commands. The user reviews the result in config.yaml. */
export function detectProject(root: string): Detection {
  const parts = [detectNode, detectDotnet, detectPython, detectGo]
    .map((detect) => detect(root))
    .filter((p): p is Partial<Detection> => p !== undefined);

  const checks: DetectedCheck[] = [];
  for (const part of parts) {
    for (const check of part.checks ?? []) {
      // Several stacks can define the same kind of check; keep them apart by name.
      const name = checks.some((c) => c.name === check.name) ? `${check.name}-${part.stacks![0]}` : check.name;
      checks.push({ name, run: check.run });
    }
  }

  return {
    stacks: parts.flatMap((p) => p.stacks ?? []),
    checks: sortChecks(checks),
    appStart: parts.find((p) => p.appStart)?.appStart,
    projectName: parts.find((p) => p.projectName)?.projectName ?? basename(root),
  };
}
