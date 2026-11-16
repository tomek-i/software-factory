// Checks a packed tarball of the npm package before it can be published: the bundle, the prompts
// and the web app are in it, and no workspace package is left for users to install.
// Usage: node apps/cli/scripts/check-pack.mjs <folder holding the one tarball>
// A folder rather than a glob, which Git Bash on Windows CI does not expand on D:\ paths.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const folder = process.argv[2];
if (!folder) throw new Error("usage: check-pack.mjs <folder>");
const tarballs = readdirSync(folder).filter((name) => name.endsWith(".tgz"));
if (tarballs.length !== 1) throw new Error(`expected one tarball in ${folder}, found ${tarballs.length}`);
const tarball = join(folder, tarballs[0]);

/** The tarball's files by path. Read here rather than with `tar`, which takes `C:` for a remote host in Git Bash. */
function entries(file) {
  const tar = gunzipSync(readFileSync(file));
  const files = new Map();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    const text = (start, length) => header.toString("utf8", start, start + length).replace(/\0.*$/s, "");
    const name = text(0, 100);
    if (!name) break;
    const prefix = text(345, 155);
    const size = parseInt(text(124, 12).trim() || "0", 8);
    files.set(prefix ? `${prefix}/${name}` : name, tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const files = entries(tarball);
const required = ["package/dist/main.js", "package/prompts/builder.md", "package/web/index.html", "package/package.json"];
const missing = required.filter((file) => !files.has(file));
if (missing.length > 0) throw new Error(`${tarball} is missing ${missing.join(", ")}`);

const pkg = JSON.parse(files.get("package/package.json").toString("utf8"));
const runtime = { ...pkg.dependencies, ...pkg.optionalDependencies };
const workspace = Object.keys(runtime).filter((name) => name.startsWith("@factory/") || String(runtime[name]).startsWith("workspace:"));
if (workspace.length > 0) throw new Error(`${tarball} depends on workspace packages: ${workspace.join(", ")}`);

console.log(`${tarball}: ${files.size} files, ${pkg.name}@${pkg.version}`);
