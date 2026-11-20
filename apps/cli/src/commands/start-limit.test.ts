import { describe, expect, it } from "vitest";
import { plain } from "../style.js";
import { localTime, startLimitLine } from "./start-limit.js";
import { describeSchedulerEvent } from "./work.js";

/** An instant at a local time today, so the expectations hold in any time zone. */
const today = (hours: number, minutes: number) => new Date(new Date().setHours(hours, minutes, 0, 0));

describe("localTime", () => {
  it("is the time alone today, and with the date on another day", () => {
    const morning = today(9, 5);
    // By calendar day, not +24 h, which is 23 or 25 hours across a daylight-saving change.
    const tomorrow = new Date(new Date(morning).setDate(morning.getDate() + 1));
    const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

    expect(localTime(morning.toISOString(), morning.getTime())).toBe("09:05");
    expect(localTime(tomorrow.toISOString(), morning.getTime())).toBe(`${date} 09:05`);
  });
});

describe("startLimitLine", () => {
  it("says how many runs started, which setting holds them, and when the next can start", () => {
    const now = today(8, 0).getTime();

    expect(startLimitLine({ started: 10, max: 10, nextStartAt: today(13, 53).toISOString() }, now)).toBe(
      "Start limit reached: 10 runs started in the last 24 h (github.max_starts_per_day). The next queued issue can start at 13:53.",
    );
    expect(startLimitLine({ started: 1, max: 1, nextStartAt: today(9, 0).toISOString() }, now)).toContain("1 run started");
  });

  it("says nothing starts while the limit is 0", () => {
    expect(startLimitLine({ started: 0, max: 0 })).toBe("Start limit: github.max_starts_per_day is 0, so no queued issue starts until it is raised.");
  });
});

describe("describeSchedulerEvent: the start limit", () => {
  it("names the project on both the hold and the lift", () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();

    expect(describeSchedulerEvent({ type: "limited", project: "shop", started: 10, max: 10, until }, plain)).toBe(
      `[shop] Start limit reached: 10 runs started in the last 24 h (github.max_starts_per_day). The next queued issue can start at ${localTime(until)}.`,
    );
    expect(describeSchedulerEvent({ type: "unlimited", project: "shop" }, plain)).toBe("[shop] Start limit lifted: queued issues can start again.");
  });
});
