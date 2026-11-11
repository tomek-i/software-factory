/** Built-in secret patterns, used when gitleaks is not installed. Deliberately high-precision. */
const PATTERNS: { rule: string; regex: RegExp }[] = [
  { rule: "aws-access-key-id", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { rule: "aws-secret-access-key", regex: /aws_?secret_?access_?key\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}\b/i },
  { rule: "github-token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { rule: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { rule: "anthropic-api-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: "openai-api-key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/ },
  { rule: "slack-token", regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { rule: "stripe-live-key", regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { rule: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "private-key", regex: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/ },
];

export interface SecretHit {
  file: string;
  line: number;
  rule: string;
}

/**
 * Scan the lines a diff adds (`git diff --unified=0`). Removed and context lines are ignored:
 * deleting a leaked key is not a new leak. Hits carry no secret text, so reports are safe to share.
 */
export function scanDiffForSecrets(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+")) {
      for (const { rule, regex } of PATTERNS) {
        if (regex.test(raw)) hits.push({ file, line, rule });
      }
      line++;
    }
  }
  return hits;
}
