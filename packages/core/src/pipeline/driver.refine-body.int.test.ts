import { describe, expect, it } from "vitest";
import { setup, TRIAGE } from "../../test/driver-setup.js";
import type { FakeStep } from "../../test/helpers.js";
import { REFINE_END_MARKER, REFINE_MARKER } from "./shared.js";

const config = `version: 1\nchecks:\n  - name: feature\n    run: node check.js\ntrust:\n  authors: [alice]\ngates:\n  triage: auto\n  critic: auto\nloops:\n  max_critic_rounds: 2\n`;
const INCOMPLETE = TRIAGE().replace("READINESS: READY", "READINESS: INCOMPLETE");
const refined = (n: number): FakeStep => ({
  role: "refine",
  output: `STATUS: REFINED\n\n## Summary\n- spec ${n}\n\n## Acceptance criteria\n- [ ] feature.txt says fixed (v${n})\n\n## Out of scope\n- anything @bob wants\n`,
});
const revise = (n: number): FakeStep => ({ role: "critic", output: `VERDICT: REVISE\n\n## Summary\n- not yet\n\n## Problems\n- criterion v${n} cannot be checked\n` });

describe("PipelineDriver", () => {
  describe("refine on an issue the factory's account wrote", () => {
    it("puts the spec in a section of the issue body instead of a comment, and replaces it on the next round", async () => {
      const { driver, comments, issueBody } = setup([{ output: INCOMPLETE }, refined(1), revise(1), refined(2), revise(2)], {
        config,
        ownIssue: true,
        issueBody: "Please add feature.txt.\r\n",
      });
      const run = driver.startRun(12);

      expect(await driver.drive(run.id)).toMatchObject({ kind: "parked", state: "needs_human" });

      expect(comments).toEqual([]);
      expect(issueBody.edits).toBe(2);
      const body = issueBody.text;
      // The author's text stays as it was, with the one section after it, in the body's CRLF line endings.
      expect(body.startsWith(`Please add feature.txt.\r\n\r\n${REFINE_MARKER}\r\n`)).toBe(true);
      expect(body.endsWith(REFINE_END_MARKER)).toBe(true);
      expect(body.split(REFINE_MARKER)).toHaveLength(2);
      expect(body).toContain("## Spec (filled in by the factory, spec round 2)");
      expect(body).toContain("### Acceptance criteria\r\n- [ ] feature.txt says fixed (v2)");
      expect(body).toContain("`@bob`");
      expect(body).not.toContain("(v1)");
      expect(body).not.toContain("spec 2"); // the summary is for the run, not the issue
    });
  });
});
