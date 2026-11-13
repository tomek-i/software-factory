import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProgram } from "./program.js";

describe("buildProgram", () => {
  it("reports the release version that release-please writes to the root package.json", () => {
    const root = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(buildProgram().version()).toBe(root.version);
  });
});
