import { describe, expect, it } from "vitest";
import type { Project } from "../store/store.js";
import type { CommandRunner, ExecResult } from "../util/exec.js";
import { AttachmentError, NotSignedInError } from "./attachments.js";
import { deleteMedia, mediaTag, publishMedia, uploadMedia } from "./media.js";

const project: Project = { id: "p", name: "demo", repo_path: "/repo", github_repo: "o/r", created_at: "" };
// A draft release's assets live under an untagged-… path until it is published.
const url = (name: string) => `https://github.com/o/r/releases/download/untagged-1a2b3c/${name}`;

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
  it("creates a draft release for the run (no tag, no release event), uploads the files and returns their URLs", () => {
    const { calls, run } = fakeGh();
    const urls = uploadMedia(project, "r1", ["/run/capture/a.png", "/run/capture/walkthrough.webm"], run);
    expect(urls).toEqual({ "a.png": url("a.png"), "walkthrough.webm": url("walkthrough.webm") });
    expect(mediaTag("r1")).toBe("factory-media-r1");
    expect(calls[1]!.slice(0, 4)).toEqual(["release", "create", "factory-media-r1", "--draft"]);
    expect(calls[1]).not.toContain("--prerelease");
    expect(calls[1]!.slice(-2)).toEqual(["-R", "o/r"]);
    expect(calls[2]).toEqual(["release", "upload", "factory-media-r1", "--clobber", "/run/capture/a.png", "/run/capture/walkthrough.webm", "-R", "o/r"]);
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

describe("deleteMedia", () => {
  it("deletes the run's release without asking", () => {
    const { calls, run } = fakeGh();
    deleteMedia(project, "r1", run);
    expect(calls).toEqual([["release", "delete", "factory-media-r1", "--yes", "-R", "o/r"]]);
    expect(() => deleteMedia(project, "r1", fakeGh({ fail: "release delete" }).run)).toThrow(/gh release delete failed: HTTP 403/);
  });
});

describe("publishMedia", () => {
  const files = ["/run/capture/a.png", "/run/capture/walkthrough.webm"];
  const attached = { "a.png": "https://github.com/user-attachments/assets/1", "walkthrough.webm": "https://github.com/user-attachments/assets/2" };

  it("attaches the media to the run's PR, without touching releases", async () => {
    const { calls, run } = fakeGh();
    const seen: unknown[] = [];
    const published = await publishMedia(project, "r1", 7, files, async (...args) => (seen.push(args), attached), run);
    expect(published).toEqual({ urls: attached });
    expect(seen).toEqual([["o/r", 7, files, undefined]]);
    expect(calls).toEqual([]);
  });

  it("falls back to the draft release, and says why, when attaching fails or there is no PR", async () => {
    const failing = async () => {
      throw new NotSignedInError();
    };
    const { run } = fakeGh();
    expect(await publishMedia(project, "r1", 7, files, failing, run)).toEqual({
      urls: { "a.png": url("a.png"), "walkthrough.webm": url("walkthrough.webm") },
      release: "factory-media-r1",
      fallback: "the factory's browser is not signed in to GitHub: run `factory login github`",
    });
    const unused = async () => {
      throw new Error("must not be called");
    };
    expect(await publishMedia(project, "r1", null, files, unused, fakeGh().run)).toMatchObject({ release: "factory-media-r1", fallback: "the run has no pull request" });
  });

  it("keeps the browser's own error out of the PR: it can name local paths", async () => {
    const launch = async () => {
      throw new AttachmentError("the factory's browser could not start", "Executable doesn't exist at C:\\Users\\alice\\AppData\\Local\\ms-playwright\\chromium");
    };
    expect(await publishMedia(project, "r1", 7, files, launch, fakeGh().run)).toMatchObject({
      fallback: "the factory's browser could not start",
      fallbackDetail: "Executable doesn't exist at C:\\Users\\alice\\AppData\\Local\\ms-playwright\\chromium",
    });
    const unexpected = async () => {
      throw new Error("ENOENT: no such file, stat 'C:\\Users\\alice\\run\\a.png'");
    };
    expect(await publishMedia(project, "r1", 7, files, unexpected, fakeGh().run)).toMatchObject({ fallback: "attaching to the PR failed", fallbackDetail: expect.stringContaining("ENOENT") });
  });

  it("makes no release for a run that stopped while it was attaching", async () => {
    const controller = new AbortController();
    const stopping = async () => {
      controller.abort();
      throw new AttachmentError("the run stopped while the media was uploading");
    };
    const { calls, run } = fakeGh();
    await expect(publishMedia(project, "r1", 7, files, stopping, run, controller.signal)).rejects.toThrow("the run stopped while the media was uploading");
    expect(calls).toEqual([]);
  });

  it("throws when the draft release fails too", async () => {
    const failing = async () => {
      throw new Error("timeout");
    };
    await expect(publishMedia(project, "r1", 7, files, failing, fakeGh({ fail: "release upload" }).run)).rejects.toThrow(/gh release upload failed/);
  });
});
