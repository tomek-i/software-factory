import { AGENT_ROLES, EFFORT_LEVELS, factoryConfigSchema, OPEN_FEEDBACK_MODES, REVIEW_LENSES, type FactoryConfig } from "./config.js";
import { GATE_MODES } from "./states.js";

/** The sections of `.factory/config.yaml`, in the order docs/configuration.md describes them. */
export const SETTING_SECTIONS = [
  { key: "project", title: "Project", about: "The project's name and the branch the factory builds from." },
  { key: "checks", title: "Checks", about: "The commands that must all pass before reviews start." },
  { key: "app", title: "App", about: "How to start your app for screenshots and videos of UI changes. Leave the start command empty and nothing is captured." },
  { key: "gates", title: "Gates", about: "Where a run stops for you. Hard rules and untrusted authors always stop for you, whatever the mode." },
  { key: "hard_rules", title: "Hard rules", about: "Changes that always stop for you, whatever the gate mode." },
  { key: "merge", title: "Merge", about: "How and when the PR is merged." },
  { key: "loops", title: "Loops", about: "How often a run may go back to an earlier stage. At the cap the run stops for you." },
  { key: "reviews", title: "Reviews", about: "Which review lenses run. The acceptance lens always runs." },
  { key: "models", title: "Models", about: "The model and effort for each agent. What you leave out uses the recommended model." },
  { key: "concurrency", title: "Concurrency", about: "How many runs go on at once." },
  { key: "trust", title: "Trust", about: "Whose issues and comments count as the spec." },
  { key: "github", title: "GitHub", about: "Status labels and the daily start limit." },
] as const;
export type SettingSection = (typeof SETTING_SECTIONS)[number]["key"];

export type SettingKind =
  | { type: "boolean" }
  | { type: "integer"; min: number; max?: number }
  | { type: "number" }
  | { type: "enum"; options: readonly string[] }
  | { type: "string" }
  | { type: "list"; options?: readonly string[] }
  | { type: "checks" }
  | { type: "models"; keys: readonly string[] };

export interface Setting {
  /** Dotted path in the config, e.g. `gates.merge`. */
  path: string;
  section: SettingSection;
  label: string;
  help: string;
  kind: SettingKind;
  /** What a change to it can let through without you; the page asks before saving one. */
  sensitive?: string;
  /** Why it can't be changed here; shown instead of an input. */
  readOnly?: string;
}

const gate = (name: string, where: string): Setting => ({
  path: `gates.${name}`,
  section: "gates",
  label: name.replace("_", " "),
  help: where,
  kind: { type: "enum", options: GATE_MODES },
  sensitive: "A gate that no longer stops for you lets runs go past that point on their own.",
});

/** Every setting of `.factory/config.yaml` (but `version`), for the web app's Settings screen. */
export const SETTINGS: readonly Setting[] = [
  { path: "project.name", section: "project", label: "Name", help: "The project's name, as the factory shows it.", kind: { type: "string" } },
  {
    path: "project.default_branch",
    section: "project",
    label: "Default branch",
    help: "The branch the factory builds from and reads this file from.",
    kind: { type: "string" },
    readOnly: "Settings are saved to this branch, so change it in the file itself.",
  },

  { path: "checks", section: "checks", label: "Checks", help: "Each runs as a shell command in the run's worktree; a failed one runs again up to its retries before the gate fails.", kind: { type: "checks" } },

  { path: "app.start", section: "app", label: "Start command", help: "A shell command, run in the worktree, that starts your app.", kind: { type: "string" } },
  { path: "app.url", section: "app", label: "URL", help: "Must contain {port}, which the factory fills in.", kind: { type: "string" } },
  { path: "app.port_env", section: "app", label: "Port variable", help: "The environment variable that carries the port.", kind: { type: "string" } },
  { path: "app.ready_timeout_sec", section: "app", label: "Ready timeout (seconds)", help: "How long the URL may take to answer.", kind: { type: "integer", min: 1 } },
  { path: "app.narrate", section: "app", label: "Narration", help: "auto, off, or a path to narrate.mjs.", kind: { type: "string" } },
  {
    path: "app.env",
    section: "app",
    label: "Environment variables",
    help: "Names of variables passed from your environment to the app. Tokens are never passed.",
    kind: { type: "list" },
    sensitive: "The app gets these variables from your environment while it runs code from the run's branch.",
  },

  gate("issue_writer", "Before factory new creates its issues."),
  gate("triage", "After triage reads the issue."),
  gate("critic", "After the spec critic checks the spec."),
  gate("plan", "Accepted, but no stage uses it yet."),
  gate("review", "After the reviews."),
  gate("pr", "Before the PR is opened."),
  gate("merge", "Before the PR is merged."),

  {
    path: "hard_rules.paths",
    section: "hard_rules",
    label: "Protected paths",
    help: "Repo-relative globs using only *, ** and ?. They add to the factory's own protected paths, which can't be removed.",
    kind: { type: "list" },
    sensitive: "A path taken off the list no longer stops a run that changes it.",
  },
  {
    path: "hard_rules.triggers",
    section: "hard_rules",
    label: "Triggers",
    help: "New dependencies, secret and environment files, and deleted files the issue doesn't name.",
    kind: { type: "list" },
    readOnly: "Every trigger always applies; none can be switched off.",
  },

  { path: "merge.method", section: "merge", label: "Method", help: "As the repo allows.", kind: { type: "enum", options: ["merge", "squash", "rebase"] } },
  { path: "merge.checks_timeout_min", section: "merge", label: "Checks timeout (minutes)", help: "How long to wait for the PR's required checks before asking you.", kind: { type: "number" } },
  {
    path: "merge.open_feedback",
    section: "merge",
    label: "Open feedback",
    help: "Unresolved review threads and failed optional checks: ask waits for you, fix sends them to the builder, ignore doesn't look at them.",
    kind: { type: "enum", options: OPEN_FEEDBACK_MODES },
    sensitive: "fix and ignore let a run act on review feedback, or merge past it, without you.",
  },
  {
    path: "merge.comment_bots",
    section: "merge",
    label: "Comment bots",
    help: "Apps whose threads fix may act on without you, as GitHub shows them.",
    kind: { type: "list" },
    sensitive: "Threads from these apps go to the builder without you.",
  },
  {
    path: "merge.followup_issues",
    section: "merge",
    label: "Follow-up issues",
    help: "Open an issue for each review note the builder defers before the merge. Off, its thread only says it was deferred.",
    kind: { type: "boolean" },
  },
  {
    path: "merge.queue_followups",
    section: "merge",
    label: "Queue follow-ups",
    help: "Queue those follow-up issues for the factory to work on, rather than leave them for you to pick.",
    kind: { type: "boolean" },
    sensitive: "Each deferred note starts a run of its own without you choosing it.",
  },

  { path: "loops.max_critic_rounds", section: "loops", label: "Critic rounds", help: "The spec critic sending the spec back to refine.", kind: { type: "integer", min: 1 } },
  { path: "loops.max_build_iterations", section: "loops", label: "Build iterations", help: "Failed checks sending the build back.", kind: { type: "integer", min: 1 } },
  { path: "loops.max_review_rounds", section: "loops", label: "Review rounds", help: "Confirmed review findings sending the build back.", kind: { type: "integer", min: 1 } },
  { path: "loops.max_resyncs", section: "loops", label: "Re-syncs", help: "The merge stage sending the build back: conflicts, failed re-checks, open feedback with fix.", kind: { type: "integer", min: 1 } },

  { path: "reviews.always", section: "reviews", label: "Every change", help: "The lenses that look at every change.", kind: { type: "list", options: REVIEW_LENSES } },
  { path: "reviews.ui", section: "reviews", label: "UI changes", help: "The lenses that only look at UI changes.", kind: { type: "list", options: REVIEW_LENSES } },

  { path: "models.default", section: "models", label: "Default model", help: "For every agent the file doesn't name.", kind: { type: "string" } },
  { path: "models.effort", section: "models", label: "Default effort", help: "For every agent the file doesn't name.", kind: { type: "enum", options: EFFORT_LEVELS } },
  { path: "models.roles", section: "models", label: "Per agent", help: "A model and effort for an agent role.", kind: { type: "models", keys: AGENT_ROLES } },
  { path: "models.reviews", section: "models", label: "Per review lens", help: "A lens without an entry uses the reviewer's.", kind: { type: "models", keys: REVIEW_LENSES } },
  { path: "models.high_risk", section: "models", label: "High risk", help: "Used on top of the rest when triage rates the risk HIGH.", kind: { type: "models", keys: [...AGENT_ROLES, ...REVIEW_LENSES] } },

  { path: "concurrency.max_runs", section: "concurrency", label: "Runs at once", help: "How many runs factory run drives at once, and the worker per project.", kind: { type: "integer", min: 1 } },

  {
    path: "trust.authors",
    section: "trust",
    label: "Trusted authors",
    help: "GitHub logins whose issues and comments count as the spec.",
    kind: { type: "list" },
    sensitive: "Issues from a trusted author can lead to a build without you approving triage.",
  },
  {
    path: "trust.everyone",
    section: "trust",
    label: "Trust everyone",
    help: "For private repos where only approved people can open issues.",
    kind: { type: "boolean" },
    sensitive: "Every issue and comment counts as the spec, whoever wrote it.",
  },

  { path: "github.status_labels", section: "github", label: "Status labels", help: "Mirror a run's status onto its issue as labels. Run factory init again to create them.", kind: { type: "boolean" } },
  { path: "github.label_prefix", section: "github", label: "Label prefix", help: "The prefix of the status labels.", kind: { type: "string" } },
  { path: "github.max_starts_per_day", section: "github", label: "Starts per day", help: "How many new runs the worker starts per project in a rolling 24 hours. Every started run counts, cancelled and rejected ones included.", kind: { type: "integer", min: 0 } },
  { path: "github.poll_interval_sec", section: "github", label: "Poll interval (seconds)", help: "Accepted, but not used yet.", kind: { type: "integer", min: 30 } },
];

/** The value of a dotted path in an object, or undefined. */
export function valueAt(object: unknown, path: string): unknown {
  let node = object;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** The config with nothing set, so the defaults always match the schema. */
export function defaultConfig(): FactoryConfig {
  return factoryConfigSchema.parse({ version: 1 });
}
