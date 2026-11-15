import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The server can start agents and merge pull requests, so it only answers this machine's browser,
 * and only a tab that opened the link `factory serve` printed:
 * - it listens on 127.0.0.1;
 * - the Host header must name it, so a web page can't reach it through DNS rebinding;
 * - every API request carries the session cookie, set from the token in that link;
 * - every change comes with this server's own Origin, so another site can't post to it.
 */

export const SESSION_COOKIE = "factory_session";

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** Constant time, so the token can't be guessed one character at a time. */
export function tokenMatches(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}
