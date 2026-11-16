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
/** Windows' long-path or device prefix in front of a drive path: `\\?\C:\x` or `\\.\C:\x`. */
const LONG_PATH = String.raw`(?:\\\\[?.]\\)?`;
/** A user name in a profile folder. */
const NAME = String.raw`[^\\/\s'"\x60<>|:;,()\[\]*?]+`;
/** A route after an HTTP method (`GET /home/settings`) is the app's, not a folder. */
const NOT_A_ROUTE = String.raw`(?<!\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE) )`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern for one folder, matching either separator; a Windows path (drive letter or
 * backslash) also in any case. A folder on a drive also matches with a long-path prefix
 * (`\\?\C:\x`) and in its Git Bash form (`/c/x`). Undefined for a filesystem root, which would
 * match everything.
 */
function folderPattern(folder: string): RegExp | undefined {
  const drive = /^([A-Za-z]):/.exec(folder)?.[1];
  const windows = drive !== undefined || folder.includes("\\");
  const segments = folder.split(/[\\/]+/);
  while (segments.length && segments[segments.length - 1] === "") segments.pop();
  if (segments.filter((s) => s !== "" && !/^[A-Za-z]:$/.test(s)).length === 0) return undefined;
  const sep = String.raw`[\\/]+`;
  const body = segments.map(escape).join(sep);
  const forms = [`${LONG_PATH}${FILE_URL}${body}`];
  if (drive) forms.push(String.raw`\/${[drive, ...segments.slice(1).map(escape)].join(sep)}`);
  // The separator is taken only with a segment after it: `<root>/ &&` must keep its `.`.
  return new RegExp(`${BEFORE}(?:${forms.join("|")})${AFTER}([\\\\/]+(?=${NAME}))?`, windows ? "gi" : "g");
}

/** Anything shaped like a user profile folder, whoever's it is. */
const PROFILES = [
  new RegExp(String.raw`${BEFORE}${LONG_PATH}${FILE_URL}[A-Za-z]:[\\/]+Users[\\/]+${NAME}`, "gi"),
  new RegExp(String.raw`${BEFORE}${NOT_A_ROUTE}${FILE_URL}\/(?:home|Users)\/${NAME}`, "g"),
  // Git Bash and MSYS tools print `C:\Users\bob` as `/c/Users/bob`.
  new RegExp(String.raw`${BEFORE}${NOT_A_ROUTE}\/[A-Za-z][\\/]+[Uu]sers[\\/]+${NAME}`, "g"),
];

/**
 * A text with local absolute paths shortened, for publishing (a PR description): a path in one of
 * the roots becomes relative to it, the home folder and anything shaped like a user profile
 * (`C:\Users\<name>`, `\\?\C:\Users\<name>`, `/c/Users/<name>`, `/home/<name>`, `/Users/<name>`)
 * become `~`. App routes and URLs stay as
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
