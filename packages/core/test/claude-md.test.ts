import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// CLAUDE.md is a map agents trust instead of reading the code, so a renamed file or function must
// fail here rather than send them looking for something that is gone. Filesystem only: no git.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_LINES = 150;
const THIS_FILE = "packages/core/test/claude-md.test.ts";

/** Relative paths (forward slashes) of every file and folder under packages/ and apps/. */
function repoEntries(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const path = `${rel}/${entry.name}`;
      out.push(entry.isDirectory() ? `${path}/` : path);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk("packages");
  walk("apps");
  return out;
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");

const headingSlugs = (markdown: string) => new Set([...markdown.matchAll(/^#{1,6} +(.+)$/gm)].map((m) => slug(m[1] ?? "")));

// Spans with a placeholder (`<role>`), a glob, a space (a command) or a leading dash (a flag) name
// no single thing that could exist, so they are not checked.
const UNCHECKABLE = /[<>{}*\s]|^-/;
const looksLikePath = (span: string) => span.includes("/") || /\.(ts|mjs|md|json|ya?ml)$/.test(span);
// Code identifiers only (camelCase, PascalCase, UPPER_SNAKE, dotted members), not plain words like `claude`.
const looksLikeSymbol = (span: string) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(span) && /[A-Z_]/.test(span);

/** Text matched literally inside a RegExp: every special character escaped, backslash included. */
const escapeRegExp = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

interface Repo {
  entries: string[];
  /** Concatenated TypeScript and .mjs sources, tests included. */
  source: string;
  read(relPath: string): string | undefined;
}

function loadRepo(): Repo {
  const entries = repoEntries();
  const source = entries
    // This file is left out: its own sample names would otherwise count as existing.
    .filter((e) => /\/(src|test)\/.*\.(ts|mjs)$/.test(e) && e !== THIS_FILE)
    .map((e) => readFileSync(join(ROOT, e), "utf8"))
    .join("\n");
  return {
    entries,
    source,
    read: (relPath) => (existsSync(join(ROOT, relPath)) ? readFileSync(join(ROOT, relPath), "utf8") : undefined),
  };
}

/** Everything in the text that names a path, symbol or link that does not exist. */
function problems(text: string, repo: Repo): { problems: string[]; checked: { paths: number; symbols: number; links: number } } {
  const found: string[] = [];
  const checked = { paths: 0, symbols: 0, links: 0 };
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "").filter((s) => !UNCHECKABLE.test(s));

  for (const span of spans) {
    if (looksLikePath(span)) {
      checked.paths++;
      // A path is written from the repo root, or shortened inside a section (`capture/`, `server.ts`).
      const ok = existsSync(join(ROOT, span)) || repo.entries.some((e) => e.endsWith(`/${span}`));
      if (!ok) found.push(`path ${span}`);
    } else if (looksLikeSymbol(span)) {
      checked.symbols++;
      for (const part of span.split(".")) {
        if (!new RegExp(`(?<![\\w$])${escapeRegExp(part)}(?![\\w$])`).test(repo.source)) found.push(`symbol ${span}`);
      }
    }
  }

  for (const [, target = ""] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^https?:/.test(target)) continue;
    checked.links++;
    const [file = "", anchor] = target.split("#");
    const linked = repo.read(file);
    if (linked === undefined) found.push(`link ${target}`);
    else if (anchor && !headingSlugs(linked).has(anchor)) found.push(`link ${target}`);
  }
  return { problems: found, checked };
}

describe("CLAUDE.md", () => {
  const repo = loadRepo();
  const text = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

  it(`stays under ${MAX_LINES} lines`, () => {
    expect(text.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(MAX_LINES);
  });

  it("names only paths, symbols and links that exist", () => {
    const result = problems(text, repo);
    expect(result.problems).toEqual([]);
    // A broken pattern would otherwise pass by checking nothing.
    expect(result.checked.paths).toBeGreaterThan(30);
    expect(result.checked.symbols).toBeGreaterThan(20);
    expect(result.checked.links).toBeGreaterThan(5);
  });

  it("matches symbol text literally, special characters included", () => {
    const special = String.raw`a\b^c$d.e*f+g?h(i)j[k]l{m}n|o/p-q`;
    expect(new RegExp(`^${escapeRegExp(special)}$`).test(special)).toBe(true);
    expect(new RegExp(escapeRegExp("a.b")).test("axb")).toBe(false);
  });

  it("reports a missing path, symbol, link target and anchor", () => {
    const sample = [
      "- `packages/core/src/pipeline/gone.ts`, `vanishedFunction`, `RunMachine.noSuchMember`",
      "- [missing](NOPE.md), [bad anchor](README.md#no-such-heading)",
      "- fine: `packages/core/src/pipeline/gates.ts`, `server.ts`, `resolveGate`, `<role>.md`, `taskkill /T /F`, [ok](README.md#trusted-authors)",
    ].join("\n");
    expect(problems(sample, repo).problems).toEqual([
      "path packages/core/src/pipeline/gone.ts",
      "symbol vanishedFunction",
      "symbol RunMachine.noSuchMember",
      "link NOPE.md",
      "link README.md#no-such-heading",
    ]);
  });
});
