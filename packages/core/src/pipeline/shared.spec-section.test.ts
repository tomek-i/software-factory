import { describe, expect, it } from "vitest";
import { REFINE_END_MARKER, REFINE_MARKER, withSpecSection } from "./shared.js";

const section = (text: string) => `${REFINE_MARKER}\n${text}\n${REFINE_END_MARKER}`;

describe("withSpecSection", () => {
  it("adds the section after the author's text, or as the whole body when there is none", () => {
    expect(withSpecSection("Please add it.\n\n", section("v1"))).toBe(`Please add it.\n\n${section("v1")}`);
    expect(withSpecSection("", section("v1"))).toBe(section("v1"));
    expect(withSpecSection("  \n", section("v1"))).toBe(section("v1"));
  });

  it("replaces the section in place, keeping the text around it", () => {
    const body = `Intro\n\n${section("v1")}\n\nAdded later by hand`;
    expect(withSpecSection(body, section("v2"))).toBe(`Intro\n\n${section("v2")}\n\nAdded later by hand`);
  });

  it("appends rather than cutting the body when the markers do not pair up", () => {
    const startOnly = `Intro ${REFINE_MARKER} quoted`;
    expect(withSpecSection(startOnly, section("v1"))).toBe(`${startOnly}\n\n${section("v1")}`);
    const reversed = `${REFINE_END_MARKER} then ${REFINE_MARKER}`;
    expect(withSpecSection(reversed, section("v1"))).toBe(`${reversed}\n\n${section("v1")}`);
  });

  it("uses the body's CRLF line endings", () => {
    expect(withSpecSection("Please add it.\r\n", section("v1"))).toBe(`Please add it.\r\n\r\n${REFINE_MARKER}\r\nv1\r\n${REFINE_END_MARKER}`);
    const body = `Intro\r\n\r\n${REFINE_MARKER}\r\nv1\r\n${REFINE_END_MARKER}\r\nAfter`;
    expect(withSpecSection(body, section("v2"))).toBe(`Intro\r\n\r\n${REFINE_MARKER}\r\nv2\r\n${REFINE_END_MARKER}\r\nAfter`);
  });
});
