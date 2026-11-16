// Markdown helpers for the tests that check the repo's own docs (CLAUDE.md, README.md, docs/).

/** GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens. */
export const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");

/** The markdown without its fenced code blocks, whose `#` comments are not headings. */
export const withoutCodeBlocks = (markdown: string) => markdown.replace(/^ *(```|~~~)[^\n]*\n[\s\S]*?^ *\1 *$/gm, "");

/** The anchor of every heading in the markdown. */
export const headingSlugs = (markdown: string) =>
  new Set([...withoutCodeBlocks(markdown).matchAll(/^#{1,6} +(.+)$/gm)].map((m) => slug(m[1] ?? "")));

/** Every inline link target (`[text](target)`), images and links inside code blocks left out. */
export const linkTargets = (markdown: string) =>
  [...withoutCodeBlocks(markdown).matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");
