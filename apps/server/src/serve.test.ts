import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isServeUrl, openInBrowser } from "./serve.js";

const URL = `http://127.0.0.1:4740/#token=${"c".repeat(64)}`;

/** A spawn that records what it was asked to start and starts nothing. */
function fakeSpawn() {
  const calls: { command: string; args: readonly string[] }[] = [];
  const fn = ((command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return { on: () => undefined, unref: () => undefined };
  }) as unknown as typeof spawn;
  return { fn, calls };
}

describe("openInBrowser", () => {
  it("accepts only the URL serve builds", () => {
    expect(isServeUrl(URL)).toBe(true);
    for (const url of [
      `${URL}&calc`,
      `${URL} & calc`,
      `http://127.0.0.1:4740/#token=${"c".repeat(64)}"|calc`,
      "http://example.com/#token=abc",
      "http://127.0.0.1:4740/#token=",
      "http://127.0.0.1:4740/#token=ABC",
      `${URL}\n`,
      "file:///C:/Windows/System32/calc.exe",
    ]) {
      expect(isServeUrl(url), url).toBe(false);
    }
  });

  it("opens the serve URL and starts nothing for anything else", () => {
    const { fn, calls } = fakeSpawn();
    expect(openInBrowser(URL, fn)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.at(-1)).toBe(URL);
    expect(openInBrowser(`${URL}" & calc & "`, fn)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
