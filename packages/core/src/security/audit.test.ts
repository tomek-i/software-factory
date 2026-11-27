import { describe, expect, it } from "vitest";
import { auditDue } from "./audit.js";

const now = Date.parse("2026-11-27T10:00:00Z");
const audit = (status: "complete" | "failed" | "cancelled" | "skipped", daysAgo: number) => ({ status, started_at: new Date(now - daysAgo * 86_400_000).toISOString() });

describe("auditDue", () => {
  it("is never due when the schedule is off", () => {
    expect(auditDue([], "off", now)).toBe(false);
  });

  it("is due with no audit yet, and once the newest is older than the interval", () => {
    expect(auditDue([], "weekly", now)).toBe(true);
    expect(auditDue([audit("complete", 6)], "weekly", now)).toBe(false);
    expect(auditDue([audit("complete", 7)], "weekly", now)).toBe(true);
    expect(auditDue([audit("complete", 8), audit("complete", 2)], "weekly", now)).toBe(false);
    expect(auditDue([audit("complete", 29)], "monthly", now)).toBe(false);
    expect(auditDue([audit("complete", 30)], "monthly", now)).toBe(true);
  });

  it("counts failed and skipped audits, so a missing plugin doesn't retry every tick, but not cancelled ones", () => {
    expect(auditDue([audit("skipped", 1)], "weekly", now)).toBe(false);
    expect(auditDue([audit("failed", 1)], "weekly", now)).toBe(false);
    expect(auditDue([audit("cancelled", 0), audit("complete", 10)], "weekly", now)).toBe(true);
  });
});
