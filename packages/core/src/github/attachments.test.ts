import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromiumInstalled } from "../capture/browser.js";
import { AttachmentError, attachmentProblem, githubProfileDir, launchProblem, newAttachmentLink, NotSignedInError, uploadAttachments } from "./attachments.js";

describe("githubProfileDir", () => {
  it("is in the user's local app data on Windows and their config dir elsewhere, never in a repo", () => {
    expect(githubProfileDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a")).toBe(join("C:\\Users\\a\\AppData\\Local", "software-factory", "github-browser"));
    expect(githubProfileDir({}, "linux", "/home/a")).toBe(join("/home/a", ".config", "software-factory", "github-browser"));
    expect(githubProfileDir({ XDG_CONFIG_HOME: "/cfg" }, "darwin", "/Users/a")).toBe(join("/cfg", "software-factory", "github-browser"));
  });
});

describe("newAttachmentLink", () => {
  const a = "https://github.com/user-attachments/assets/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";
  const b = "https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555";

  it("finds the link GitHub inserts for an image or a video", () => {
    expect(newAttachmentLink(`<img width="1440" alt="x" src="${a}" />`, new Set())).toBe(a);
    expect(newAttachmentLink(`![after-home-1440.png](${a})`, new Set())).toBe(a);
    expect(newAttachmentLink(`\n${a}\n`, new Set())).toBe(a);
  });

  it("skips links already taken by an earlier file, and finds nothing while the upload runs", () => {
    expect(newAttachmentLink(`${a}\n${b}`, new Set([a]))).toBe(b);
    expect(newAttachmentLink(a, new Set([a]))).toBeUndefined();
    expect(newAttachmentLink("![Uploading after-home-1440.png…]()", new Set())).toBeUndefined();
    expect(newAttachmentLink("https://github.com/o/r/releases/download/x/a.png", new Set())).toBeUndefined();
  });
});

describe("attachmentProblem", () => {
  it("refuses files over GitHub's limits before waiting for an upload", () => {
    expect(attachmentProblem("a.png", 10 * 1024 * 1024)).toBeUndefined();
    expect(attachmentProblem("a.png", 11 * 1024 * 1024)).toBe("a.png is 11.0 MB, over GitHub's 10 MB limit for images");
    expect(attachmentProblem("walkthrough.webm", 50 * 1024 * 1024)).toBeUndefined();
    expect(attachmentProblem("walkthrough-narrated.MP4", 101 * 1024 * 1024)).toMatch(/over GitHub's 100 MB limit for videos/);
  });
});

const available = await chromiumInstalled();

/**
 * A stand-in for github.com: `/o/r/pull/1` is a PR page with a signed-in user and a comment box
 * whose file input answers each upload with a new attachment link, like GitHub's editor;
 * `/o/r/pull/2` is the same page signed out; on `/o/r/pull/3` uploads never finish.
 */
describe.skipIf(!available)("uploadAttachments (real browser)", () => {
  let server: Server;
  let base: string;
  let dir: string;
  const page = (signedIn: boolean, answers = true) => `<!doctype html><html><head>${signedIn ? '<meta name="user-login" content="alice">' : ""}</head><body>
<form><textarea name="comment[body]"></textarea><input type="file"></form>
<script>
  let n = 0;
  const box = document.querySelector("textarea");
  if (${answers}) document.querySelector("input").addEventListener("change", (e) => {
    const name = e.target.files[0].name;
    box.value += "![Uploading " + name + "…]()";
    setTimeout(() => { n++; box.value = box.value.replace("![Uploading " + name + "…]()", "![" + name + "](https://github.com/user-attachments/assets/id-" + n + ")"); }, 200);
  });
</script></body></html>`;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(page(req.url !== "/o/r/pull/2", req.url !== "/o/r/pull/3"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), "factory-attach-"));
    writeFileSync(join(dir, "a.png"), "png");
    writeFileSync(join(dir, "walkthrough.webm"), "webm");
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    // Chromium's helper processes can hold the profile for a moment after it closed (Windows).
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("uploads each file through the comment box and returns its own link", async () => {
    const links = await uploadAttachments("o/r", 1, [join(dir, "a.png"), join(dir, "walkthrough.webm")], { baseUrl: base, profile: join(dir, "profile") });
    expect(links).toEqual({ "a.png": "https://github.com/user-attachments/assets/id-1", "walkthrough.webm": "https://github.com/user-attachments/assets/id-2" });
  });

  it("says so when the profile is not signed in, and when no link comes back", async () => {
    await expect(uploadAttachments("o/r", 2, [join(dir, "a.png")], { baseUrl: base, profile: join(dir, "profile") })).rejects.toBeInstanceOf(NotSignedInError);
    await expect(uploadAttachments("o/r", 3, [join(dir, "a.png")], { baseUrl: base, profile: join(dir, "profile"), timeoutMs: 1000 })).rejects.toThrow(
      new AttachmentError("no attachment link came back for a.png in time"),
    );
  });

  it("lets two runs upload at the same time: the second waits for the profile instead of failing", async () => {
    const profile = join(dir, "shared-profile");
    const [first, second] = await Promise.all([
      uploadAttachments("o/r", 1, [join(dir, "a.png")], { baseUrl: base, profile }),
      uploadAttachments("o/r", 1, [join(dir, "walkthrough.webm")], { baseUrl: base, profile }),
    ]);
    expect(first).toEqual({ "a.png": "https://github.com/user-attachments/assets/id-1" });
    expect(second).toEqual({ "walkthrough.webm": "https://github.com/user-attachments/assets/id-1" });
  });

  it("closes the browser and stops when the run stops", async () => {
    const controller = new AbortController();
    const upload = uploadAttachments("o/r", 3, [join(dir, "a.png")], { baseUrl: base, profile: join(dir, "profile"), signal: controller.signal });
    setTimeout(() => controller.abort(), 3000);
    await expect(upload).rejects.toThrow(new AttachmentError("the run stopped while the media was uploading"));
  });
});

describe("launchProblem", () => {
  it("names a profile another browser holds, and hides the browser's own message", () => {
    const locked = launchProblem(new Error("browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory C:\\Users\\alice\\AppData\\Local\\software-factory\\github-browser"));
    expect(locked.message).toBe("the factory's browser profile is in use (another upload, or `factory login github` is open)");
    expect(locked.detail).toContain("ProcessSingleton");
    const missing = launchProblem(new Error("Executable doesn't exist at C:\\Users\\alice\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome.exe"));
    expect(missing.message).toBe("the factory's browser could not start");
    expect(missing.message).not.toContain("alice");
  });
});
