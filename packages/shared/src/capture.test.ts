import { describe, expect, it } from "vitest";
import { capturePlanSchema, parseCapturePlan, walkthroughStepSchema } from "./capture.js";

const body = (plan: unknown) => `## Summary\n- shows the tab\n\n## Plan\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\n`;
const home = { name: "home", path: "/", screen: "existing" };

describe("parseCapturePlan", () => {
  it("reads the pages and the walkthrough from the ## Plan block", () => {
    const plan = {
      pages: [home, { name: "invoices", path: "/invoices?tab=open", screen: "new", why: "added by the change" }],
      walkthrough: [
        { action: "goto", path: "/" },
        { action: "click", text: "Invoices" },
        { action: "click", selector: "#save" },
        { action: "fill", selector: "#name", value: "Acme" },
        { action: "wait", ms: 500 },
        { action: "screenshot", name: "saved" },
      ],
    };
    expect(parseCapturePlan(body(plan))).toEqual({ plan, problems: [] });
  });

  it("defaults the walkthrough to none", () => {
    expect(parseCapturePlan(body({ pages: [home] })).plan).toEqual({ pages: [home], walkthrough: [] });
  });

  it("says what is wrong with a missing, doubled or broken block", () => {
    expect(parseCapturePlan("## Summary\n- x\n").problems).toEqual(["## Plan with a ```json block is missing"]);
    expect(parseCapturePlan(`${body({ pages: [home] })}\`\`\`json\n{}\n\`\`\`\n`).problems).toEqual(["## Plan must contain exactly one ```json block"]);
    expect(parseCapturePlan("## Plan\n```json\n{ nope\n```\n").problems[0]).toMatch(/^plan JSON is invalid/);
    expect(parseCapturePlan(body({ pages: [] })).problems).toEqual(["plan.pages: Too small: expected array to have >=1 items"]);
  });
});

describe("capture plan validation", () => {
  const valid = (plan: unknown) => capturePlanSchema.safeParse(plan).success;

  it("only accepts same-origin paths", () => {
    for (const path of ["/", "/a/b?c=1#d", "/settings"]) expect(valid({ pages: [{ ...home, path }] }), path).toBe(true);
    for (const path of ["https://evil.example/", "//evil.example/x", "evil.example", "javascript:alert(1)", "/a\\b", "/a b", "/a\nb", ""]) {
      expect(valid({ pages: [{ ...home, path }] }), path).toBe(false);
      expect(walkthroughStepSchema.safeParse({ action: "goto", path }).success, path).toBe(false);
    }
  });

  it("only accepts the declarative steps, never code", () => {
    expect(walkthroughStepSchema.safeParse({ action: "evaluate", script: "fetch('/x')" }).success).toBe(false);
    expect(walkthroughStepSchema.safeParse({ action: "goto", path: "/", script: "alert(1)" }).success).toBe(false);
    expect(walkthroughStepSchema.safeParse({ action: "click" }).success).toBe(false);
    expect(walkthroughStepSchema.safeParse({ action: "click", selector: "#a", text: "A" }).success).toBe(false);
    expect(walkthroughStepSchema.safeParse({ action: "wait", ms: 60_000 }).success).toBe(false);
  });

  it("wants file-name-safe, unique names and bounded sizes", () => {
    expect(valid({ pages: [{ ...home, name: "../etc" }] })).toBe(false);
    expect(valid({ pages: [{ ...home, name: "Home" }] })).toBe(false);
    expect(valid({ pages: [{ ...home, screen: "changed" }] })).toBe(false);
    expect(parseCapturePlan(body({ pages: [home, home] })).problems).toEqual(["plan.pages: page names must be unique: home"]);
    const shot = { action: "screenshot", name: "a" };
    expect(parseCapturePlan(body({ pages: [home], walkthrough: [shot, shot] })).problems).toEqual(["plan.walkthrough: screenshot names must be unique: a"]);
    expect(valid({ pages: Array.from({ length: 11 }, (_, i) => ({ ...home, name: `p${i}` })) })).toBe(false);
    expect(valid({ pages: [home], walkthrough: Array.from({ length: 31 }, () => ({ action: "wait", ms: 1 })) })).toBe(false);
  });
});
