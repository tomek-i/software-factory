import type { Detection } from "./detect.js";

const q = (s: string) => JSON.stringify(s);

/** Render a commented starter config. Values not listed fall back to the schema defaults. */
export function renderConfig(detection: Detection): string {
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

# How to start the app for screenshots and walkthrough videos. {port} is replaced per run.
app:
${detection.appStart ? `  start: ${q(detection.appStart)}` : '  # start: "npm run dev"'}
  url: "http://localhost:{port}"
  port_env: "PORT"

# Gate modes: always (pass through) | auto (agent decides or escalates) | human (always stop for you)
gates:
  issue_writer: human
  triage: auto
  critic: auto
  plan: always
  review: auto
  pr: always
  merge: human

# Changes matching these always come to you, whatever the gate mode.
# Only a per-run --unsafe flag can lift them; it cannot be set here.
hard_rules:
  paths:
    - "**/auth/**"
    - "**/migrations/**"
    - ".github/workflows/**"
    - "infra/**"
    - ".factory/config.yaml"
  triggers:
    - new_dependency
    - secrets_or_env_changes
    - deletes_files_outside_scope

loops:
  max_build_iterations: 5
  max_review_rounds: 3
  max_critic_rounds: 2

reviews:
  always: [code, security, docs]
  ui: [ux, ui]          # only when the change touches the UI

models:
  default: "opus"
  roles: {}             # e.g. reviewer: "sonnet"

concurrency:
  max_runs: 2

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
