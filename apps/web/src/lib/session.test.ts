// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { sessionToken, takeTokenFromUrl } from "./session";

const TOKEN = "e".repeat(64);

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("takeTokenFromUrl", () => {
  it("keeps the token from the link's fragment and drops it from the address bar", () => {
    window.history.replaceState(null, "", `/inbox?x=1#token=${TOKEN}`);

    takeTokenFromUrl();

    expect(sessionToken()).toBe(TOKEN);
    expect(localStorage.getItem("factory.token")).toBe(TOKEN);
    expect(window.location.href).toBe("http://localhost:3000/inbox?x=1");
  });

  it("leaves other fragments alone", () => {
    window.history.replaceState(null, "", "/runs#token=<script>");

    takeTokenFromUrl();

    expect(window.location.hash).toBe("#token=%3Cscript%3E");
    expect(localStorage.getItem("factory.token")).toBeNull();
  });
});
