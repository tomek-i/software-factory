import { createHash } from "node:crypto";
import { isBlocking, type Finding } from "@factory/shared";
import type { QualityGateResult } from "../gate/gate.js";

/**
 * Fingerprints say whether a loop failed "the same way" twice, so a builder that keeps producing
 * the same failure is stopped before the loop cap. Matching is exact on normalised text: when in
 * doubt this under-matches, because a missed repeat only falls back to the cap.
 */

// CSI sequences (colours, cursor moves) and OSC sequences (titles, hyperlinks).
// eslint-disable-next-line no-control-regex -- matching escape characters is the point
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
// "1.2s", "340ms", "12 ms", "3 seconds"; single-letter units only when attached to the number.
const DURATION = /(?<![\w.])\d+(?:\.\d+)?(?:(?:ns|µs|us|ms|s|m|h)\b|\s?(?:ms|secs?|seconds?|mins?|minutes?)\b)/g;
// Commit shas (abbreviated or full): lowercase hex with at least one digit and one letter, so
// plain numbers and hex-looking words stay.
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Normalise tool output before hashing, so noise that changes every round does not hide a repeat. */
export function normaliseOutput(text: string, paths: string[] = []): string {
  let out = text.replace(ANSI, "").replace(/\r\n?/g, "\n");
  for (const path of paths) {
    const trimmed = path.replace(/[\\/]+$/, "");
    if (!trimmed) continue;
    const parts = trimmed.split(/[\\/]+/);
    // Escaped backslashes (as in JSON) first, so the plain forms do not leave half of them behind.
    for (const sep of ["\\\\", "\\", "/"]) {
      out = out.replace(new RegExp(escapeRegExp(parts.join(sep)), "gi"), "<path>");
    }
  }
  return out
    .replace(TIMESTAMP, "<time>")
    .replace(DURATION, "<duration>")
    .replace(SHA, "<sha>")
    .replace(/\s+/g, " ")
    .trim();
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Fingerprint of a failed quality gate: which checks failed and how (timed out, exit code,
 * normalised output tail), plus the secret-scan hits. The commit, durations and round are left out.
 */
export function gateFingerprint(result: Pick<QualityGateResult, "checks" | "secrets">, worktreePath: string): string {
  const checks = result.checks
    .filter((c) => !c.passed)
    .map((c) => ({
      name: c.name,
      timedOut: c.timedOut,
      // A killed process's exit code says how it was killed, not how it failed.
      exitCode: c.timedOut ? null : (c.exitCode ?? null),
      tail: normaliseOutput(c.tail, [worktreePath]),
    }));
  const secrets = [...new Set(result.secrets.hits.map((h) => `${h.file.replace(/\\/g, "/")} ${h.rule}`))].sort();
  return hash({ checks, secrets });
}

/**
 * Fingerprint of the verifier's confirmed findings: file, severity and normalised claim of each
 * blocking finding, in any order. Ids, line numbers and evidence shift between rounds and are left out.
 */
export function findingsFingerprint(findings: Finding[]): string {
  const keys = findings
    .filter(isBlocking)
    .map((f) => JSON.stringify([f.file?.replace(/\\/g, "/") ?? "", f.severity, normaliseOutput(f.claim)]))
    .sort();
  return hash(keys);
}
