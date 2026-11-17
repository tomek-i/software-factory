import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "3 minutes ago" from an ISO time; the exact time goes in a title. */
export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** A run's loop counters, "b2 r1", plus its re-syncs with the default branch once it has any. */
export function rounds(run: { build: number; review: number; resyncs: number }): string {
  const resyncs = run.resyncs ? `, ${run.resyncs} re-sync${run.resyncs > 1 ? "s" : ""}` : "";
  return `b${run.build} r${run.review}${resyncs}`;
}
