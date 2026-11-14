import { describe, expect, it } from "vitest";
import type { CaptureResult, PageCapture } from "./capture.js";
import { comparable, newErrors, renderCaptureReport, screenshotsSection } from "./report.js";

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

  it("sees the same error through a rebuild's chunk hashes and cache-busting values", () => {
    expect(comparable("HTTP 404: GET /assets/index-BkX9_2aQ.js?v=1700000000")).toBe("HTTP 404: GET /assets/index-[hash].js?v=[v]");
    expect(comparable("request failed: GET /static/main.3f9a1c2b.css (net::ERR_FAILED)")).toBe("request failed: GET /static/main.[hash].css (net::ERR_FAILED)");
    expect(comparable("HTTP 500: GET /api/items?page=2&t=123")).toBe("HTTP 500: GET /api/items?page=2&t=[v]");
    const rebuilt: PageCapture = {
      name: "home",
      path: "/",
      screen: "existing",
      after: [shot("after", "home", 1440, ["HTTP 404: GET /assets/index-AAAAAAAA.js?v=2", "console error: boom"])],
      before: [shot("before", "home", 1440, ["HTTP 404: GET /assets/index-BBBBBBBB.js?v=1"])],
    };
    expect(newErrors([rebuilt])).toEqual([{ page: "home", width: 1440, errors: ["console error: boom"], compared: true }]);
  });

  it("does not compare with a before page that did not load", () => {
    const failedBefore: PageCapture = { ...pages[0]!, before: [{ width: 1440, signals: ["HTTP 404: GET /old.css"], error: "timeout" }, pages[0]!.before![1]!] };
    expect(newErrors([failedBefore])[0]).toEqual({ page: "home", width: 1440, errors: ["console error: boom", "HTTP 404: GET /old.css"], compared: false });
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
    const text = screenshotsSection({ result, urls }, "r1");
    expect(text).toMatch(/^## Screenshots\n\n\| Page \| Before \| After \|\n\|---\|---\|---\|\n/);
    expect(text).toContain(`| **home** \`/\` 1440px | <img src="${urls["before-home-1440.png"]}" alt="home before, 1440px" width="360"> | <img src="${urls["after-home-1440.png"]}"`);
    expect(text).toContain("| **invoices** `/invoices` 1440px | _new screen_ | <img");
    expect(text).toContain("| **invoices** `/invoices` 390px | _new screen_ | failed: `timeout` |");
    expect(text).toContain(`**Walkthrough video:** [walkthrough.webm](${urls["walkthrough.webm"]})`);
    expect(text).toContain("**New browser errors**\n- home at 1440px: `console error: boom`\n- invoices at 1440px: `page error: x is undefined`");
    expect(text).toContain("- no before shot of invoices (/invoices): it is a new screen");
  });

  it("links the narrated video instead of the silent one, and says why there is no narration", () => {
    const narrated = { ...result, walkthrough: { ...result.walkthrough!, narrated: "/run/round-1/capture/walkthrough-narrated.mp4" } };
    const url = "https://github.com/o/r/releases/download/factory-media-r1/walkthrough-narrated.mp4";
    const text = screenshotsSection({ result: narrated, urls: { ...urls, "walkthrough-narrated.mp4": url } }, "r1");
    expect(text).toContain(`**Walkthrough video (narrated):** [walkthrough-narrated.mp4](${url})`);
    expect(text).not.toContain("walkthrough.webm");
    expect(renderCaptureReport({ result: narrated, urls })).toContain("- narrated video: walkthrough-narrated.mp4");

    const silent = { ...result, walkthrough: { ...result.walkthrough!, narrationProblem: "narrate failed (exit 1); see narrate/narrate.log\nC:\\Users\\me" } };
    const pr = screenshotsSection({ result: silent, urls }, "r1");
    expect(pr).toContain(`**Walkthrough video:** [walkthrough.webm](${urls["walkthrough.webm"]})`);
    expect(pr).toContain("No narration: `narrate failed (exit 1); see narrate/narrate.log`");
    expect(pr).not.toContain("C:\\Users");
    expect(renderCaptureReport({ result: silent, urls })).toContain("- no narration: narrate failed (exit 1)");
  });

  it("keeps app text from rendering as markup", () => {
    const evil = [{ ...pages[1]!, after: [shot("after", "invoices", 1440, ["console error: <img src=x onerror=alert(1)> `tick`"])] }];
    expect(screenshotsSection({ result: { ...result, pages: evil }, urls }, "r1")).toContain("`console error: <img src=x onerror=alert(1)> 'tick'`");
  });

  it("says why there are none, with only the first line of the message, as code", () => {
    expect(screenshotsSection({ problem: "the app did not start (after): boom" }, "r1")).toBe(
      "## Screenshots\nScreenshots could not be taken: `the app did not start (after): boom`. Details: `factory show r1 capture`.",
    );
    expect(screenshotsSection({ result, uploadProblem: "HTTP 403" }, "r1")).toBe(
      "## Screenshots\nScreenshots were taken but could not be uploaded: `HTTP 403`. Details: `factory show r1 capture`.",
    );
    expect(screenshotsSection({ skipped: "nothing to show" }, "r1")).toBe("## Screenshots\nNo screenshots: `nothing to show`");
  });

  it("keeps the app's log tail out of the PR, and in the report", () => {
    const problem = "the app did not start (after): `npm run dev` exited (code 1) before http://localhost:4700 answered\nError: cannot read C:\\Users\\me\\.env\nDATABASE_URL=postgres://me:pw@db\ncc @someone";
    const pr = screenshotsSection({ problem }, "r1");
    expect(pr).toBe("## Screenshots\nScreenshots could not be taken: `the app did not start (after): 'npm run dev' exited (code 1) before http://localhost:4700 answered`. Details: `factory show r1 capture`.");
    for (const leak of ["C:\\Users", "DATABASE_URL", "@someone"]) expect(pr).not.toContain(leak);
    const report = renderCaptureReport({ problem });
    expect(report).toContain("- screenshots could not be taken: the app did not start (after): `npm run dev` exited (code 1) before http://localhost:4700 answered\n");
    expect(report).toContain("## Details\n\n```text\nthe app did not start");
    expect(report).toContain("DATABASE_URL=postgres://me:pw@db\ncc @someone\n```");
  });

  describe("local paths", () => {
    const paths = { home: "/home/alice", roots: ["D:\\work\\repo"] };
    // As long as the real hint (about 245 characters), so the path starts near where the first line is cut.
    const hint = "Playwright is not installed. ".repeat(8);
    const win = `${hint}(Cannot find package 'playwright' imported from C:\\Users\\alice\\repo\\packages\\core\\dist\\capture\\browser.js)`;

    it("are shortened in every message the PR shows, also past where the first line is cut", () => {
      const pr = screenshotsSection({ problem: win }, "r1", paths);
      expect(pr).toContain("Cannot find package 'playwright' imported from ~");
      expect(pr).not.toContain("alice");

      const msg = (where: string) => `${where}: cannot read /home/alice/repo/x.js`;
      const leaky: PageCapture[] = [
        { ...pages[0]!, after: [shot("after", "home", 1440, [msg("console error")]), { width: 390, signals: [], error: msg("shot") }] },
      ];
      const captured: CaptureResult = {
        ...result,
        pages: leaky,
        beforeProblem: "git worktree add failed: fatal: C:/Users/alice/repo/.git is locked",
        walkthrough: { ...result.walkthrough!, problem: msg("walkthrough"), narrationProblem: msg("narration") },
      };
      const full = screenshotsSection({ result: captured, urls, mediaFallback: msg("fallback") }, "r1", paths);
      for (const where of ["console error", "shot", "walkthrough", "narration", "fallback"]) expect(full).toContain(`${where}: cannot read ~/repo/x.js`);
      expect(full).toContain("fatal: ~/repo/.git is locked");
      expect(screenshotsSection({ result, uploadProblem: "gh: open D:\\work\\repo\\round-1\\a.png: denied" }, "r1", paths)).toContain("`gh: open round-1\\a.png: denied`");
      for (const text of [pr, full]) {
        expect(text).not.toContain("alice");
        expect(text).not.toContain("D:\\work");
      }
    });

    it("leave routes and URLs as they are", () => {
      const text = screenshotsSection({ result, urls }, "r1", paths);
      expect(text).toBe(screenshotsSection({ result, urls }, "r1"));
      expect(text).toContain("| **invoices** `/invoices` 1440px");
      expect(text).toContain("- no before shot of invoices (/invoices): it is a new screen");
      expect(screenshotsSection({ problem: "the app did not answer at http://localhost:4700/x" }, "r1", paths)).toContain("`the app did not answer at http://localhost:4700/x`");
    });

    it("stay whole in the report", () => {
      const report = renderCaptureReport({ problem: win });
      expect(report).toContain(`## Details\n\n\`\`\`text\n${win}\n\`\`\``);
      const short = "Cannot find package 'playwright' imported from /home/alice/repo/browser.js";
      expect(renderCaptureReport({ problem: short })).toContain(`- screenshots could not be taken: ${short}\n`);
    });
  });
});
