/** Over a route's limit: a 429, with how many seconds to wait. */
export class TooManyRequests extends Error {
  constructor(readonly retryAfter: number) {
    super(`Too many requests; try again in ${retryAfter} s.`);
  }
}

export interface RateLimit {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
}

/**
 * A fixed-window counter per key (a route). The server answers one person's browser, so the
 * limit is per route, not per client: it caps how often the route touches the disk at all.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a request; throws TooManyRequests when the key is over its limit for this window. */
  take(key: string): void {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || now - window.start >= this.limit.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit.max) throw new TooManyRequests(Math.max(1, Math.ceil((window.start + this.limit.windowMs - now) / 1000)));
    window.count++;
  }
}
