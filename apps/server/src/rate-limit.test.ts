import { describe, expect, it } from "vitest";
import { RateLimiter, TooManyRequests } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows max requests per window and key, then says how long to wait, and starts over in the next window", () => {
    let now = 1_000;
    const limiter = new RateLimiter({ max: 2, windowMs: 10_000 }, () => now);

    limiter.take("GET /a");
    limiter.take("GET /a");
    limiter.take("GET /b");
    now += 2_500;
    expect(() => limiter.take("GET /a")).toThrow(new TooManyRequests(8));
    expect(() => limiter.take("GET /a")).toThrow(/^Too many requests; try again in 8 s\.$/);

    now += 7_500;
    expect(() => limiter.take("GET /a")).not.toThrow();
    expect(() => limiter.take("GET /a")).not.toThrow();
    expect(() => limiter.take("GET /a")).toThrow(TooManyRequests);
  });
});
