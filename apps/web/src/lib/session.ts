/**
 * The session token from the link `factory serve` printed (`/#token=…`). The fragment never reaches
 * a server, so the page takes it, drops it from the address bar, and sends it as a header with
 * every API call. Kept in this origin's storage, so other tabs of the same server have it too; a new
 * `factory serve` makes a new one, and the old one is simply refused.
 */
const KEY = "factory.token";
let current: string | undefined;

function stored(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Takes the token from the address bar, if it has one. Called once, before the app renders. */
export function takeTokenFromUrl(location: Location = window.location, history: History = window.history): void {
  const match = /^#token=([0-9a-f]+)$/.exec(location.hash);
  if (!match) return;
  current = match[1];
  try {
    localStorage.setItem(KEY, current!);
  } catch {
    // Not remembered: this tab still has it.
  }
  history.replaceState(null, "", location.pathname + location.search);
}

export function sessionToken(): string | undefined {
  return current ?? stored();
}

export const TOKEN_HEADER = "X-Factory-Token";
