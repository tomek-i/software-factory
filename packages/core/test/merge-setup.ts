import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryConfigSchema } from "@factory/shared";
import { approveTarget, waitingCommit } from "../src/pipeline/driver.js";
import { RunMachine } from "../src/pipeline/transitions.js";
import type { Store } from "../src/store/store.js";
import { git, REVIEW_PASS, type FakeStep } from "./helpers.js";

// Shared by the driver.merge*.int.test.ts files. The merge tests are split across files because each
// drives real git repos: in one file they ran one after another and held up the whole suite.

/** One review lens, so a round is quick; `gates` sets the PR and merge gates. */
export const mergeConfig = (gates: string, extra = "") =>
  `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n${gates
    .split("\n")
    .map((g) => `  ${g}\n`)
    .join("")}reviews:\n  always: [code]\n  ui: []\n${extra}`;

export const CODE_PASS: FakeStep = { role: "reviewer-code", output: REVIEW_PASS };

/** A human approves the gate the run waits at, naming the commit when it is the merge gate. */
export function approve(store: Store, runId: string) {
  const run = store.getRun(runId)!;
  const commitSha = run.waiting_gate === "merge" ? waitingCommit(store.listEvents(runId)) : undefined;
  new RunMachine(store, factoryConfigSchema.parse({ version: 1 })).resume(runId, approveTarget(run, "build")!, { comment: "go", commitSha });
}

/** Commit a change straight to main on origin, as if another PR had been merged meanwhile. */
export function landOnMain(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "chore: meanwhile on main");
  git(root, "push", "-q", "origin", "main");
}

export const moves = (store: Store, runId: string) => store.listEvents(runId).map((e) => `${e.from_state ?? "-"}>${e.to_state}`);
