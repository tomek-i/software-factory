import { describe, expect, it } from "vitest";
import type { CaptureResult, PageCapture } from "./capture.js";
import { newErrors, renderCaptureReport, screenshotsSection } from "./report.js";

const shot = (prefix: string, page: string, width: number, signals: string[] = []) => ({ width, file: `/run/round-1/capture/${prefix}-${page}-${width}.png`, signals });

const pages: PageCapture[] = [
  {
    name: "home",
    path: "/",
    screen: "existing",
    after: [shot("after", "home", 1440, ["console error: boom", "HTTP 404: GET /old.css"]), shot("after", "home", 390, ["HTTP 404: GET /old.css"])],
    before: [shot("before", "home", 1440, ["HTTP 404: GET /old.css"]), shot("before", "home", 390, ["HTTP 404: GET /old.css"])],
  },
  { name: "invoices", path: "/invoices", screen: "new", after: [shot("after", "invoices", 1440, ["page error: x is undefined"]), { width: 390, signals: [], error: "timeout" }] },
];
const result: CaptureResult = {
  status: "captured",
  pages,
  walkthrough: { video: "/run/round-1/capture/walkthrough.webm", screenshots: ["/run/round-1/capture/step-saved.png"], ran: 4, signals: [] },
  notes: ["no before shot of invoices (/invoices): it is a new screen"],
};
const urls = Object.fromEntries(
  ["after-home-1440.png", "after-home-390.png", "before-home-1440.png", "before-home-390.png", "after-invoices-1440.png", "walkthrough.webm", "step-saved.png"].map((f) => [f, `https://github.com/o/r/releases/download/factory-media-r1/${f}`]),
);

describe("newErrors", () => {
  it("reports only what the default branch did not have, and everything on a new screen", () => {
    expect(newErrors(pages)).toEqual([
      { page: "home", width: 1440, errors: ["console error: boom"], compared: true },
      { page: "invoices", width: 1440, errors: ["page error: x is undefined"], compared: false },
    ]);
  });
});

describe("renderCaptureReport", () => {
  it("lists the pages, the new errors, the walkthrough and the notes", () => {
    const text = renderCaptureReport({ result, urls });
    expect(text).toContain("## Summary\n- 2 page(s) at 1440 and 390 px; before shots of 1 existing screen(s)\n- 2 new browser error(s), see New errors\n- walkthrough recorded (4 steps)\n- media uploaded (7 files)");
    expect(text).toContain("| home | `/` | existing | 1440 | before-home-1440.png | after-home-1440.png |");
    expect(text).toContain("| invoices | `/invoices` | new | 390 | new screen | failed: timeout |");
    expect(text).toContain("### home at 1440px\n- console error: boom");
    expect(text).toContain("### invoices at 1440px (nothing to compare with)\n- page error: x is undefined");
    expect(text).not.toContain("old.css");
    expect(text).toContain("- video: walkthrough.webm");
    expect(text).toContain("## Notes\n- no before shot of invoices (/invoices): it is a new screen");
  });

  it("says why there are no screenshots, and reports a failed walkthrough and upload", () => {
    expect(renderCaptureReport({ problem: "the app did not start (after): boom" })).toContain("- screenshots could not be taken: the app did not start (after): boom");
    expect(renderCaptureReport({ result: { status: "skipped", problem: "install playwright", pages: [], notes: [] } })).toContain("could not be taken: install playwright");
    expect(renderCaptureReport({ skipped: "the capture agent found nothing to show" })).toContain("- no screenshots: the capture agent found nothing to show");
    const failed = { ...result, walkthrough: { ...result.walkthrough!, ran: 2, problem: 'step 3 (click text "Save"): Timeout 10000ms exceeded.' } };
    const text = renderCaptureReport({ result: failed, uploadProblem: "gh release create failed: HTTP 403", restored: ["dist/out.js"] });
    expect(text).toContain('- walkthrough stopped after 2 step(s): step 3 (click text "Save"): Timeout 10000ms exceeded. (the video shows how far it got)');
    expect(text).toContain("- media could not be uploaded: gh release create failed: HTTP 403");
    expect(text).toContain("- the app left changes in the worktree, which were undone: dist/out.js");
  });
});

describe("screenshotsSection", () => {
  it("shows a before/after table, the video and the new errors", () => {
    const text = screenshotsSection({ result, urls }, "r1")!;
    expect(text).toMatch(/^## Screenshots\n\n\| Page \| Before \| After \|\n\|---\|---\|---\|\n/);
    expect(text).toContain(`| **home** \`/\` 1440px | <img src="${urls["before-home-1440.png"]}" alt="home before, 1440px" width="360"> | <img src="${urls["after-home-1440.png"]}"`);
    expect(text).toContain("| **invoices** `/invoices` 1440px | _new screen_ | <img");
    expect(text).toContain("| **invoices** `/invoices` 390px | _new screen_ | _failed: timeout_ |");
    expect(text).toContain(`**Walkthrough video:** [walkthrough.webm](${urls["walkthrough.webm"]})`);
    expect(text).toContain("**New browser errors**\n- home at 1440px: `console error: boom`\n- invoices at 1440px: `page error: x is undefined`");
    expect(text).toContain("- no before shot of invoices (/invoices): it is a new screen");
  });

  it("keeps app text from rendering as markup", () => {
    const evil = [{ ...pages[1]!, after: [shot("after", "invoices", 1440, ["console error: <img src=x onerror=alert(1)> `tick`"])] }];
    expect(screenshotsSection({ result: { ...result, pages: evil }, urls }, "r1")).toContain("`console error: <img src=x onerror=alert(1)> 'tick'`");
  });

  it("says why there are none", () => {
    expect(screenshotsSection({ problem: "the app did not start (after): boom" }, "r1")).toBe("## Screenshots\nScreenshots could not be taken: the app did not start (after): boom");
    expect(screenshotsSection({ result, uploadProblem: "HTTP 403" }, "r1")).toBe(
      "## Screenshots\nScreenshots were taken but could not be uploaded: HTTP 403. They are in the run folder: `factory show r1 capture`.",
    );
    expect(screenshotsSection({ skipped: "nothing to show" }, "r1")).toBe("## Screenshots\nNo screenshots: nothing to show");
  });
});
