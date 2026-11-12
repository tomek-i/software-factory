import { describe, expect, it } from "vitest";
import { leftApp, redirectsAway } from "./browser.js";

const origin = "http://127.0.0.1:4701";

describe("leftApp", () => {
  it("is false only on the app's own origin (or before any page loaded)", () => {
    expect(leftApp("http://127.0.0.1:4701/settings?x=1", origin)).toBe(false);
    expect(leftApp("about:blank", origin)).toBe(false);
    expect(leftApp("http://127.0.0.1:4702/", origin)).toBe(true);
    expect(leftApp("http://localhost:4701/", origin)).toBe(true);
    expect(leftApp("https://evil.example/", origin)).toBe(true);
    // Where Chromium ends up after the guard blocked a navigation.
    expect(leftApp("chrome-error://chromewebdata/", origin)).toBe(true);
    expect(leftApp("not a url", origin)).toBe(true);
  });
});

describe("redirectsAway", () => {
  const from = `${origin}/go`;

  it("catches a 3xx whose Location is another origin, absolute or protocol-relative", () => {
    for (const status of [301, 302, 303, 307, 308]) expect(redirectsAway(status, "https://evil.example/x", from, origin), String(status)).toBe(true);
    expect(redirectsAway(302, "//evil.example/x", from, origin)).toBe(true);
    expect(redirectsAway(302, "http://127.0.0.1:9999/", from, origin)).toBe(true);
  });

  it("lets same-origin redirects and other responses through", () => {
    expect(redirectsAway(302, "/login", from, origin)).toBe(false);
    expect(redirectsAway(302, "login?next=/go", from, origin)).toBe(false);
    expect(redirectsAway(302, `${origin}/home`, from, origin)).toBe(false);
    expect(redirectsAway(200, "https://evil.example/", from, origin)).toBe(false);
    expect(redirectsAway(302, undefined, from, origin)).toBe(false);
  });
});
