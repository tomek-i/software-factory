import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CapturePort, CaptureRequest, CaptureResult } from "../src/capture/capture.js";
import { buildStep, review, TRIAGE } from "./driver-setup.js";
import type { FakeStep } from "./helpers.js";

// Shared by the driver.capture*.test.ts files, which are split so their tests run in parallel.

/** One review lens, the merge gate waits for a human, and an app to start unless `app` says otherwise. */
export const captureConfig = (app = 'app:\n  start: "node app.js"\n') =>
  `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  merge: human\nreviews:\n  always: [code]\n  ui: []\n${app}`;
export const UI_TRIAGE = TRIAGE().replace("SURFACES: api", "SURFACES: ui, api");
// A minor finding, so the PR has review notes the screenshots must not replace.
export const CODE_PASS: FakeStep = { role: "reviewer-code", output: review("PASS", "minor") };
export const PLAN = [
  "CAPTURE: PLAN",
  "",
  "## Summary",
  "- the feature page",
  "",
  "## Plan",
  "```json",
  JSON.stringify({
    pages: [
      { name: "home", path: "/", screen: "existing" },
      { name: "feature", path: "/feature", screen: "new" },
    ],
    walkthrough: [{ action: "goto", path: "/feature" }],
  }),
  "```",
  "",
].join("\n");
export const steps = (capture: FakeStep | FakeStep[] = { role: "capture", output: PLAN }): FakeStep[] => [
  { output: UI_TRIAGE },
  buildStep("fixed"),
  CODE_PASS,
  ...[capture].flat(),
];

/**
 * A capture port without a browser: writes stand-in media into the run folder (as the real one
 * does), optionally leaves a file in the worktree, and returns `result` or a captured result.
 */
export function fakeCapture(options: { result?: Partial<CaptureResult>; throws?: string; uploadError?: string; litter?: boolean; attached?: boolean } = {}) {
  const requests: CaptureRequest[] = [];
  const uploads: string[][] = [];
  const prNumbers: (number | null)[] = [];
  const discarded: string[] = [];
  const port: CapturePort = {
    capture: async (request) => {
      requests.push(request);
      if (options.throws) throw new Error(options.throws);
      if (options.litter) writeFileSync(join(request.worktreePath, "server.pid"), "123\n");
      const file = (name: string) => {
        const path = join(request.outDir, name);
        writeFileSync(path, "media");
        return path;
      };
      return {
        status: "captured",
        pages: [
          {
            name: "home",
            path: "/",
            screen: "existing",
            after: [{ width: 1440, file: file("after-home-1440.png"), signals: ["console error: boom", "HTTP 404: GET /old.css"] }],
            before: [{ width: 1440, file: file("before-home-1440.png"), signals: ["HTTP 404: GET /old.css"] }],
          },
          { name: "feature", path: "/feature", screen: "new", after: [{ width: 1440, file: file("after-feature-1440.png"), signals: [] }] },
        ],
        walkthrough: { video: file("walkthrough.webm"), screenshots: [], ran: 1, signals: [] },
        notes: ["no before shot of feature (/feature): it is a new screen"],
        ...options.result,
      };
    },
    // Unless `attached`, attaching fails and the media goes to the draft release, as without a signed-in browser.
    publish: async (runId, prNumber, files) => {
      uploads.push(files);
      prNumbers.push(prNumber);
      if (options.uploadError) throw new Error(options.uploadError);
      if (options.attached) return { urls: Object.fromEntries(files.map((f) => [basename(f), `https://github.com/user-attachments/assets/${basename(f).replace(/\W/g, "-")}`])) };
      const urls = Object.fromEntries(files.map((f) => [basename(f), `https://github.com/o/r/releases/download/factory-media-${runId}/${basename(f)}`]));
      return { urls, release: `factory-media-${runId}`, fallback: "the factory's browser is not signed in to GitHub: run `factory login github`" };
    },
    discard: (runId) => {
      discarded.push(runId);
    },
  };
  return { port, requests, uploads, prNumbers, discarded };
}

export const infos = (seen: { type: string; message?: string }[]) => seen.flatMap((e) => (e.type === "info" ? [e.message!] : []));
