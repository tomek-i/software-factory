import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { headingSlugs, linkTargets, slug } from "./markdown.js";

// The README and docs/ are written one fact per line, so two branches that change different facts
// do not conflict on one long line. Filesystem only: no git, no network.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_LINE = 300;

const DOCS = readdirSync(join(ROOT, "docs"))
  .filter((name) => name.endsWith(".md"))
  .map((name) => `docs/${name}`);
/** Files whose lines are kept short. */
const ONE_FACT_PER_LINE = ["README.md", ...DOCS];
/** Files whose links must resolve. CLAUDE.md is checked by claude-md.test.ts. */
const LINKED = [...ONE_FACT_PER_LINE, "SECURITY.md", "CONTRIBUTING.md"];

const PIPELINE_STAGES = [
  "Triage",
  "Refine",
  "Spec critic",
  "Build",
  "Quality gate",
  "Reviews",
  "Verifier",
  "Review gate",
  "Capture and PR",
  "Re-sync and merge gate",
  "Merge",
  "Learn",
];

const read = (relPath: string) => readFileSync(join(ROOT, relPath), "utf8");

/**
 * Lines over the limit, as `file:line (length)`. Table rows are left out, and a URL or link target
 * counts as nothing, so a badge row or a long link does not need wrapping.
 */
function longLines(relPath: string, text: string, max = MAX_LINE): string[] {
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (/^\s*\|/.test(line)) return [];
    const length = line.replace(/\]\([^)\s]*\)/g, "]()").replace(/https?:\/\/\S+/g, "").length;
    return length > max ? [`${relPath}:${i + 1} (${length})`] : [];
  });
}

/** Repo-relative path a link in `fromFile` points at, and its anchor. External links give undefined. */
function resolveLink(fromFile: string, target: string): { file: string; anchor?: string } | undefined {
  if (/^[a-z][a-z+.-]*:/i.test(target)) return undefined;
  const [path = "", anchor] = target.split("#");
  const file = path === "" ? fromFile : posix.normalize(posix.join(posix.dirname(fromFile), path));
  return anchor ? { file, anchor } : { file };
}

/** Links in the file whose target file or heading does not exist. */
function brokenLinks(relPath: string, text: string): string[] {
  return linkTargets(text).flatMap((target) => {
    const link = resolveLink(relPath, target);
    if (!link) return [];
    const full = join(ROOT, link.file);
    if (!existsSync(full)) return [`${relPath}: ${target}`];
    if (link.anchor && !headingSlugs(readFileSync(full, "utf8")).has(link.anchor)) return [`${relPath}: ${target}`];
    return [];
  });
}

const linksTo = (fromFile: string, text: string, file: string) =>
  linkTargets(text).some((target) => resolveLink(fromFile, target)?.file === file);

describe("README.md and docs/", () => {
  it("finds the docs", () => {
    expect(DOCS).toContain("docs/pipeline.md");
  });

  it(`has no line over ${MAX_LINE} characters, apart from tables and URLs`, () => {
    expect(ONE_FACT_PER_LINE.flatMap((file) => longLines(file, read(file)))).toEqual([]);
  });

  it("links only to files and headings that exist", () => {
    expect(LINKED.flatMap((file) => brokenLinks(file, read(file)))).toEqual([]);
  });

  it("links from the README to every doc, and from every doc back to the README", () => {
    const readme = read("README.md");
    expect(DOCS.filter((doc) => !linksTo("README.md", readme, doc))).toEqual([]);
    expect(DOCS.filter((doc) => !linksTo(doc, read(doc), "README.md"))).toEqual([]);
  });

  it("gives every pipeline stage its own section in docs/pipeline.md", () => {
    const sections = [...read("docs/pipeline.md").matchAll(/^## +(.+)$/gm)].map((m) => m[1]?.trim());
    expect(sections.filter((s) => PIPELINE_STAGES.includes(s ?? ""))).toEqual(PIPELINE_STAGES);
  });
});

describe("doc checks", () => {
  it("counts a link target or URL as short, but not a table row only by its pipes", () => {
    const link = `- [text](${"a".repeat(400)}.md) and https://example.com/${"b".repeat(400)}`;
    const prose = `- ${"word ".repeat(70)}`;
    expect(longLines("x.md", [link, `| ${"c".repeat(400)} |`, prose].join("\n"))).toEqual(["x.md:3 (352)"]);
  });

  it("resolves links relative to the file they are in", () => {
    expect(resolveLink("docs/a.md", "../README.md#pipeline")).toEqual({ file: "README.md", anchor: "pipeline" });
    expect(resolveLink("docs/a.md", "b.md")).toEqual({ file: "docs/b.md" });
    expect(resolveLink("docs/a.md", "#here")).toEqual({ file: "docs/a.md", anchor: "here" });
    expect(resolveLink("README.md", "https://example.com/x.md")).toBeUndefined();
  });

  it("reports a missing file and a missing heading, and skips code blocks", () => {
    const text = [
      "[gone](docs/nope.md) [bad](docs/trust.md#nope) [ok](docs/trust.md#trusted-authors)",
      "## A heading",
      "```sh",
      "# not a heading, [nor a link](missing.md)",
      "```",
    ].join("\n");
    expect(brokenLinks("README.md", text)).toEqual(["README.md: docs/nope.md", "README.md: docs/trust.md#nope"]);
    expect(headingSlugs(text)).toEqual(new Set([slug("A heading")]));
  });
});
