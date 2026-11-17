import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The README and docs/ are written one fact per line, so two branches that change different facts
// touch different lines and merge cleanly. These checks keep it that way, and keep the links
// between the files working after a section moves.
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_LINE = 300;

const DOCS = ["README.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];
// Files the README and docs link to that are not docs themselves, but whose anchors are checked too.
const LINKED = [...DOCS, "CLAUDE.md", "SECURITY.md", "CONTRIBUTING.md"];

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");

/** The lines outside fenced code blocks, with their 1-based numbers. */
function prose(markdown: string): { line: string; no: number }[] {
  const out: { line: string; no: number }[] = [];
  let fenced = false;
  markdown.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced) out.push({ line, no: i + 1 });
  });
  return out;
}

const headingSlugs = (markdown: string) =>
  new Set(prose(markdown).flatMap(({ line }) => /^#{1,6} +(.+)$/.exec(line)?.[1] ?? []).map(slug));

const read = (relPath: string) => readFileSync(join(ROOT, relPath), "utf8");

describe("README and docs", () => {
  it.each(DOCS)("%s keeps prose lines short", (file) => {
    // Table rows and lines carrying a URL (badges) cannot be split without breaking them.
    const long = prose(read(file))
      .filter(({ line }) => line.length > MAX_LINE && !line.startsWith("|") && !/https?:\/\//.test(line))
      .map(({ no, line }) => `${file}:${no} (${line.length} chars)`);
    expect(long).toEqual([]);
  });

  it.each(LINKED)("%s links only to files and headings that exist", (file) => {
    const broken: string[] = [];
    for (const { line } of prose(read(file))) {
      for (const [, target = ""] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target)) continue;
        const [path = "", anchor] = target.split("#");
        const linked = path === "" ? file : normalize(join(dirname(file), path)).replace(/\\/g, "/");
        if (!existsSync(join(ROOT, linked))) broken.push(target);
        else if (anchor && (!linked.endsWith(".md") || !headingSlugs(read(linked)).has(anchor))) broken.push(target);
      }
    }
    expect(broken).toEqual([]);
  });

  // The README is a short landing page; docs/README.md is the index that lists every doc.
  it("links the README to the docs index, the index to every doc, and every doc back", () => {
    expect(read("README.md")).toContain("](docs/README.md)");
    const index = read("docs/README.md");
    const docs = DOCS.filter((f) => f !== "README.md" && f !== "docs/README.md");
    expect(docs.length).toBeGreaterThan(5);
    expect(docs.filter((f) => !index.includes(`](${f.slice("docs/".length)})`))).toEqual([]);
    expect(docs.filter((f) => !/\]\((\.\.\/)?README\.md[)#]/.test(read(f)))).toEqual([]);
  });

  it("gives every pipeline stage its own section", () => {
    const stages = [
      "Overview",
      "Triage",
      "Refine",
      "Spec critic",
      "Build",
      "Quality gate",
      "Reviews",
      "Verifier",
      "Review gate",
      "Capture and PR",
      "Merge stage",
      "Learn",
    ];
    const sections = prose(read("docs/pipeline.md")).flatMap(({ line }) => /^## (.+)$/.exec(line)?.[1] ?? []);
    expect(sections).toEqual(stages);
  });
});
