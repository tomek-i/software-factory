import { DEFAULT_MODELS, type ModelSpec } from "@factory/shared";
import type { Detection } from "./detect.js";

const q = (s: string) => JSON.stringify(s);

const spec = (s: ModelSpec) => (s.effort ? `{ model: ${q(s.model!)}, effort: ${q(s.effort)} }` : q(s.model!));

/** The recommended models as a commented-out `models:` section, generated so it never drifts from the schema. */
function renderModelDefaults(): string {
  const group = (name: string, entries: Record<string, ModelSpec>) => [
    `#   ${name}:`,
    ...Object.entries(entries).map(([key, value]) => `#     ${key}: ${spec(value)}`),
  ];
  return [
    "# models:",
    `#   default: ${q(DEFAULT_MODELS.default)}`,
    `#   effort: ${q(DEFAULT_MODELS.effort)}`,
    ...group("roles", DEFAULT_MODELS.roles),
    ...group("reviews", DEFAULT_MODELS.reviews),
    ...group("high_risk", DEFAULT_MODELS.high_risk),
  ].join("\n");
}

/** Render a commented starter config. Values not listed fall back to the schema defaults. */
export function renderConfig(detection: Detection, options: { operatorLogin?: string } = {}): string {
  const authors = options.operatorLogin ? `[${q(options.operatorLogin)}]` : "[]   # add your GitHub handle";
  // An empty `checks:` key would parse as null, so write an explicit empty list when nothing was found.
  const checks = detection.checks.length
    ? `checks:\n${detection.checks.map((c) => `  - name: ${q(c.name)}\n    run: ${q(c.run)}`).join("\n")}`
    : '# No checks detected. Add the commands that must pass before review, e.g.\n#   - name: test\n#     run: "npm test"\nchecks: []';

  return `# Software factory configuration. Commit this file.
# Detected stack: ${detection.stacks.join(", ") || "unknown"}
version: 1

project:
  name: ${q(detection.projectName)}
  default_branch: "main"

# Quality gate: every command must exit 0 before reviews start.
# The gate always uses the copy of this file on the default branch, so a branch cannot weaken its own checks.
${checks}

# How to start the app for screenshots and walkthrough videos of UI changes. {port} is replaced per run.
# start also runs in a fresh checkout of the default branch (for the before shots), so include the
# install step if the app needs one, e.g. "npm ci && npm run dev". Needs Playwright's browsers:
# run "npx playwright install chromium" in the factory's install folder (see the factory's README).
app:
${detection.appStart ? `  start: ${q(detection.appStart)}` : '  # start: "npm run dev"'}
  url: "http://localhost:{port}"
  port_env: "PORT"
  ready_timeout_sec: 180
  # The app only gets PATH, temp and home folders and the like from your environment (its pages are
  # published). List further variable names it needs here; tokens are never passed.
  env: []

# Gate modes: always (pass through) | auto (agent decides or escalates) | human (always stop for you)
gates:
  issue_writer: human
  triage: auto
  critic: auto
  plan: always
  review: auto
  pr: always
  merge: human

# Changes matching hard rules always come to you, whatever the gate mode.
# Built in and always on: **/auth/**, **/migrations/**, .github/workflows/**, infra/**, .factory/**,
# plus new dependencies, secret/env file changes and deleting files outside the issue's scope.
# Add your own protected paths here; the built-in ones cannot be removed.
# Only a per-run --unsafe flag can lift hard rules; it cannot be set here.
hard_rules:
  paths: []

loops:
  max_build_iterations: 5
  max_review_rounds: 3
  max_critic_rounds: 2

reviews:
  always: [code, security, docs]
  ui: [ux, ui]          # only when the change touches the UI
  # The acceptance lens always runs: it checks the issue's acceptance criteria one by one.

# Model and effort per agent. Left out, every agent uses the recommended model below, and a better
# recommendation reaches this project with the next factory update. To change one, uncomment
# \`models:\`, its group and the entry. Whatever you set wins over every recommendation (default
# and effort reach every agent you do not name); the recommendations only fill in the rest.
# An entry is a model alias ("sonnet") or { model, effort }; either half falls back to the less
# specific level. Effort: low | medium | high | xhigh | max.
# Most specific wins: high_risk (when triage rated RISK: HIGH) > reviews (per lens) > roles > default.
# \`factory config reset models\` removes the section again.
${renderModelDefaults()}

concurrency:
  max_runs: 2

# Whose issues and comments agents may treat as the spec. Others are handled as untrusted data,
# and their triage always waits for your approval before anything is built.
# Set everyone: true for private repos where only approved people can open issues.
trust:
  authors: ${authors}
  everyone: false

# Issues are synced from GitHub into the local database and you choose which ones to queue.
# Labels are optional and only mirror run status onto the issue; they never feed work in.
# After enabling status_labels, run \`factory init\` again to create them.
github:
  status_labels: false
  label_prefix: "factory"
  poll_interval_sec: 120
  max_starts_per_day: 10
`;
}
