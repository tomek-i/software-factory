import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The server can start agents and merge pull requests, so it only answers this machine's browser,
 * and only a tab that opened the link `factory serve` printed:
 * - it listens on 127.0.0.1;
 * - the Host header must name it, so a web page can't reach it through DNS rebinding;
 * - every API request carries the token from that link in a header. The link has it in the
 *   fragment, which never reaches a server; the page keeps it and sends it itself. Not a cookie: a
 *   browser sends cookies to every port of 127.0.0.1, so any other local server the user opens would
 *   get it. Another site can't add the header without a CORS preflight, which this server never allows;
 * - every change comes with this server's own Origin as well.
 */

export const TOKEN_HEADER = "x-factory-token";

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** Constant time, so the token can't be guessed one character at a time. */
export function tokenMatches(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
