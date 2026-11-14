import { homedir } from "node:os";

export interface RedactOptions {
  /** The home folder, shown as `~`. */
  home?: string;
  /** Folders whose paths are shown relative to them, e.g. the repository. */
  roots?: string[];
}

/** Not part of a path just before it, so `/repo` does not match inside `/x/repo` or a URL. */
const BEFORE = String.raw`(?<![\w.~\\/-])`;
/** Ends a path segment, so `/home/al` does not match `/home/alice`. */
const AFTER = String.raw`(?=$|[\\/\s'"\x60<>|:;,()\[\]])`;
/** A `file://` URL of a local path: `file:///C:/x` or `file:///home/x`. */
const FILE_URL = String.raw`(?:file:\/\/\/?)?`;
/** A user name in a profile folder. */
const NAME = String.raw`[^\\/\s'"\x60<>|:;,()\[\]*?]+`;
/** A route after an HTTP method (`GET /home/settings`) is the app's, not a folder. */
const NOT_A_ROUTE = String.raw`(?<!\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE) )`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern for one folder, matching either separator; a Windows path (drive letter or
 * backslash) also in any case. Undefined for a filesystem root, which would match everything.
 */
function folderPattern(folder: string): RegExp | undefined {
  const windows = /^[A-Za-z]:/.test(folder) || folder.includes("\\");
  const segments = folder.split(/[\\/]+/);
  while (segments.length && segments[segments.length - 1] === "") segments.pop();
  if (segments.filter((s) => s !== "" && !/^[A-Za-z]:$/.test(s)).length === 0) return undefined;
  const body = segments.map(escape).join(String.raw`[\\/]+`);
  return new RegExp(`${BEFORE}${FILE_URL}${body}${AFTER}([\\\\/]+)?`, windows ? "gi" : "g");
}

/** Anything shaped like a user profile folder, whoever's it is. */
const PROFILES = [
  new RegExp(String.raw`${BEFORE}${FILE_URL}[A-Za-z]:[\\/]+Users[\\/]+${NAME}`, "gi"),
  new RegExp(String.raw`${BEFORE}${NOT_A_ROUTE}${FILE_URL}\/(?:home|Users)\/${NAME}`, "g"),
];

/**
 * A text with local absolute paths shortened, for publishing (a PR description): a path in one of
 * the roots becomes relative to it, the home folder and anything shaped like a user profile
 * (`C:\Users\<name>`, `/home/<name>`, `/Users/<name>`) become `~`. App routes and URLs stay as
 * they are. The rest of the message is kept, so it still says what went wrong.
 */
export function redactPaths(text: string, { home = homedir(), roots = [] }: RedactOptions = {}): string {
  let out = text;
  // The longest root first, so a worktree inside the repository is relative to the worktree.
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    const pattern = folderPattern(root);
    if (pattern) out = out.replace(pattern, (_match, sep?: string) => (sep ? "" : "."));
  }
  const pattern = home ? folderPattern(home) : undefined;
  if (pattern) out = out.replace(pattern, (_match, sep?: string) => `~${sep ?? ""}`);
  for (const profile of PROFILES) out = out.replace(profile, "~");
  return out;
}
