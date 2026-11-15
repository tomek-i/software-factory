import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers.js";
import { readStopRequest, requestStop, stopFilePath } from "./stop.js";

describe("stop requests", () => {
  it("live next to the project list, in the factory's data folder", () => {
    expect(stopFilePath({ FACTORY_DATA_DIR: "/data" })).toBe(join("/data", "stop.json"));
  });

  it("are written and read back", () => {
    const file = join(tempDir(), "sub", "stop.json");
    expect(readStopRequest(file)).toBeUndefined();

    requestStop({}, file, 1_000);
    expect(readStopRequest(file)).toEqual({ at: 1_000, now: false });
    requestStop({ now: true }, file, 2_000);
    expect(readStopRequest(file)).toEqual({ at: 2_000, now: true });
  });

  it("are ignored when the file can't be read, rather than stopping every worker", () => {
    const file = join(tempDir(), "stop.json");
    writeFileSync(file, "{ nope");
    expect(readStopRequest(file)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ now: true }));
    expect(readStopRequest(file)).toBeUndefined();
  });
});
