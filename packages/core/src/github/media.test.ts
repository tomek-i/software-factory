import { describe, expect, it } from "vitest";
import type { Project } from "../store/store.js";
import type { CommandRunner, ExecResult } from "../util/exec.js";
import { mediaTag, uploadMedia } from "./media.js";

const project: Project = { id: "p", name: "demo", repo_path: "/repo", github_repo: "o/r", created_at: "" };
const url = (name: string) => `https://github.com/o/r/releases/download/factory-media-r1/${name}`;

/** A fake gh: `release view --json tagName` fails until the release exists. */
function fakeGh(options: { exists?: boolean; fail?: string; assets?: string[] } = {}) {
  const calls: string[][] = [];
  let exists = options.exists ?? false;
  const run: CommandRunner = (_cmd, args): ExecResult => {
    calls.push(args);
    const sub = args.slice(0, 2).join(" ");
    if (options.fail === sub) return { code: 1, stdout: "", stderr: "HTTP 403" };
    if (sub === "release view" && args.includes("tagName")) return exists ? { code: 0, stdout: "{}", stderr: "" } : { code: 1, stdout: "", stderr: "release not found" };
    if (sub === "release create") exists = true;
    if (sub === "release view") return { code: 0, stdout: JSON.stringify({ assets: (options.assets ?? ["a.png", "walkthrough.webm"]).map((name) => ({ name, url: url(name) })) }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("uploadMedia", () => {
  it("creates a prerelease for the run, uploads the files and returns their URLs", () => {
    const { calls, run } = fakeGh();
    const urls = uploadMedia(project, "r1", ["/run/capture/a.png", "/run/capture/walkthrough.webm"], run);
    expect(urls).toEqual({ "a.png": url("a.png"), "walkthrough.webm": url("walkthrough.webm") });
    expect(mediaTag("r1")).toBe("factory-media-r1");
    expect(calls[1]!.slice(0, 6)).toEqual(["release", "create", "factory-media-r1", "-R", "o/r", "--prerelease"]);
    expect(calls[1]).toContain("--latest=false");
    expect(calls[2]).toEqual(["release", "upload", "factory-media-r1", "-R", "o/r", "--clobber", "/run/capture/a.png", "/run/capture/walkthrough.webm"]);
  });

  it("reuses the run's release in a later round", () => {
    const { calls, run } = fakeGh({ exists: true });
    uploadMedia(project, "r1", ["/run/capture/a.png"], run);
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["release view", "release upload", "release view"]);
  });

  it("fails loudly when gh fails or an asset is missing", () => {
    expect(() => uploadMedia(project, "r1", ["/x/a.png"], fakeGh({ fail: "release upload" }).run)).toThrow(/gh release upload failed: HTTP 403/);
    expect(() => uploadMedia(project, "r1", ["/x/b.png"], fakeGh().run)).toThrow(/b\.png is missing from release factory-media-r1/);
    expect(() => uploadMedia({ ...project, github_repo: null }, "r1", [], fakeGh().run)).toThrow(/no GitHub repository/);
  });
});
