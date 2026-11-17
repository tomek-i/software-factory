import { z } from "zod";
import { GATE_MODES } from "./states.js";

const gateMode = z.enum(GATE_MODES);

export const checkSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  timeout_sec: z.number().int().positive().default(900),
});

export const HARD_RULE_TRIGGERS = ["new_dependency", "secrets_or_env_changes", "deletes_files_outside_scope"] as const;

/** Paths that always escalate to a human. Config can add to these but not remove them. */
export const DEFAULT_PROTECTED_PATHS = [
  "**/auth/**",
  "**/migrations/**",
  ".github/workflows/**",
  "infra/**",
  ".factory/**",
] as const;

/**
 * A protected-path glob: repo-relative, forward slashes, only `*`, `**` and `?`. Anything else
 * would match nothing without a word, so a path the user meant to protect would not be.
 */
const protectedPath = z
  .string()
  .min(1)
  .refine((p) => !/[{}[\]\\]/.test(p) &&!p.startsWith("/") && !p.startsWith("./"), {
    message: "use a repo-relative glob with forward slashes and only *, ** and ? (no {a,b}, [abc], leading / or backslashes)",
  });

/**
 * `acceptance` checks the issue's and the spec's acceptance criteria one by one. The engine runs it in
 * every review round whatever `reviews.always` and `reviews.ui` say (see `reviewLenses` in core).
 */
export const REVIEW_LENSES = ["code", "security", "docs", "ux", "ui", "acceptance"] as const;
export type ReviewLens = (typeof REVIEW_LENSES)[number];

export const AGENT_ROLES = [
  "issue_writer",
  "triage",
  "refine",
  "critic",
  "builder",
  "reviewer",
  "verifier",
  "capture",
  "approver",
  "learner",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Claude Code's `--effort` levels. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface ModelSpec {
  model?: string;
  effort?: Effort;
}

/** A model alias on its own, or a model and/or effort. Either half may be left to the fallbacks. */
const modelSpec = z
  .union([
    z.string().min(1),
    z
      .object({ model: z.string().min(1).optional(), effort: z.enum(EFFORT_LEVELS).optional() })
      .strict(),
  ])
  .transform((spec): ModelSpec => (typeof spec === "string" ? { model: spec } : spec));

/**
 * The recommended model per agent, so a config only holds what a project chose itself and a better
 * default reaches every project that did not override it. These sit below the config as a whole:
 * whatever the config sets (`default` and `effort` included) wins over every recommendation, and a
 * recommendation only fills in what the config leaves open. See `resolveModel`.
 */
export const DEFAULT_MODELS = {
  default: "opus",
  effort: "high",
  roles: {
    triage: { model: "opus" },
    issue_writer: { model: "opus" },
    refine: { model: "sonnet", effort: "medium" },
    critic: { model: "opus" },
    // Most of the tokens go here; high effort only when triage rated the risk HIGH.
    builder: { model: "opus", effort: "medium" },
    // Lenses without their own entry.
    reviewer: { model: "sonnet", effort: "medium" },
    // A different model from the reviewers it checks.
    verifier: { model: "sonnet" },
    approver: { model: "opus" },
    capture: { model: "haiku", effort: "low" },
    learner: { model: "sonnet", effort: "medium" },
  },
  reviews: {
    code: { model: "sonnet", effort: "medium" },
    security: { model: "opus", effort: "high" },
    docs: { model: "haiku", effort: "low" },
    ux: { model: "sonnet", effort: "medium" },
    ui: { model: "haiku", effort: "low" },
  },
  high_risk: {
    builder: { model: "opus", effort: "high" },
    code: { model: "opus", effort: "high" },
  },
} as const satisfies {
  default: string;
  effort: Effort;
  roles: Partial<Record<AgentRole, ModelSpec>>;
  reviews: Partial<Record<ReviewLens, ModelSpec>>;
  high_risk: Partial<Record<AgentRole | ReviewLens, ModelSpec>>;
};

export const factoryConfigSchema = z.object({
  version: z.literal(1),
  project: z
    .object({
      name: z.string().optional(),
      // Goes into git commands as a ref, so a name git would read as an option (`--upload-pack=…`)
      // or would refuse as a branch name is rejected here.
      default_branch: z
        .string()
        .regex(/^(?!-)(?!.*\.\.)[^\s~^:?*[\\\p{Cc}]+(?<![./])$/u, "not a valid git branch name")
        .default("main"),
    })
    .prefault({}),
  checks: z.array(checkSchema).default([]),
  app: z
    .object({
      start: z.string().optional(),
      // The app gets a free port per run, so a URL without {port} would point at the wrong app.
      url: z
        .string()
        .refine((u) => u.includes("{port}"), { message: "must contain {port}, which is replaced by the port the app is started on" })
        .default("http://localhost:{port}"),
      port_env: z.string().default("PORT"),
      // How long `start` may take until `url` answers. It also runs in a fresh checkout of the
      // default branch for the before shots, so an install step in `start` has to fit in here.
      ready_timeout_sec: z.number().int().positive().default(180),
      // Names of further variables the app gets from the factory's environment; it gets only what a
      // shell and Node need otherwise. Tokens (GH_TOKEN, ANTHROPIC_API_KEY, ...) are never passed.
      env: z.array(z.string().min(1)).default([]),
      // The narrated walkthrough: `auto` uses the narrate Claude Code plugin when it is installed (and
      // ffmpeg is on PATH), `off` keeps the silent video only, anything else is a path to narrate.mjs.
      narrate: z.string().min(1).default("auto"),
    })
    .prefault({}),
  gates: z
    .object({
      issue_writer: gateMode.default("human"),
      triage: gateMode.default("auto"),
      critic: gateMode.default("auto"),
      plan: gateMode.default("always"),
      review: gateMode.default("auto"),
      pr: gateMode.default("always"),
      merge: gateMode.default("human"),
    })
    .prefault({}),
  // The defaults are a floor: config can add paths but never remove them, otherwise an empty list
  // would be a way to switch hard rules off without --unsafe.
  hard_rules: z
    .object({
      paths: z
        .array(protectedPath)
        .default([])
        .transform((paths) => [...new Set([...DEFAULT_PROTECTED_PATHS, ...paths])]),
      triggers: z
        .array(z.enum(HARD_RULE_TRIGGERS))
        .default([])
        .transform(() => [...HARD_RULE_TRIGGERS]),
    })
    .prefault({}),
  loops: z
    .object({
      max_build_iterations: z.number().int().min(1).default(5),
      max_review_rounds: z.number().int().min(1).default(3),
      max_critic_rounds: z.number().int().min(1).default(2),
      // Times the merge stage may go back to the builder because the default branch conflicted or
      // broke the quality gate; counted apart from review rounds.
      max_resyncs: z.number().int().min(1).default(3),
    })
    .prefault({}),
  reviews: z
    .object({
      always: z.array(z.enum(REVIEW_LENSES)).default(["code", "security", "docs"]),
      ui: z.array(z.enum(REVIEW_LENSES)).default(["ux", "ui"]),
    })
    .prefault({}),
  models: z
    .object({
      // Only what the config itself sets: the recommendations (DEFAULT_MODELS) are applied below all of
      // it in resolveModel, so that `default` or `roles.reviewer` here still beat a recommended entry.
      default: z.string().min(1).optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
      roles: z.partialRecord(z.enum(AGENT_ROLES), modelSpec).default({}),
      // Per review lens; a lens without an entry uses roles.reviewer.
      reviews: z.partialRecord(z.enum(REVIEW_LENSES), modelSpec).default({}),
      // Applied on top of everything else when triage rated the issue RISK: HIGH.
      high_risk: z.partialRecord(z.enum([...AGENT_ROLES, ...REVIEW_LENSES]), modelSpec).default({}),
    })
    .prefault({}),
  concurrency: z
    .object({
      max_runs: z.number().int().min(1).default(2),
    })
    .prefault({}),
  // Whose issue text and comments the agents may treat as the spec. Anything else is handled as
  // untrusted data and triage always waits for a human before it can lead to a build.
  trust: z
    .object({
      authors: z.array(z.string().min(1)).default([]),
      // For private repos where only approved people can open issues.
      everyone: z.boolean().default(false),
    })
    .prefault({}),
  merge: z
    .object({
      // How the factory merges a PR: a merge commit, one squashed commit titled after the PR, or a rebase.
      method: z.enum(["merge", "squash", "rebase"]).default("merge"),
      // How long the merge stage waits for checks that branch protection requires, before asking a human.
      checks_timeout_min: z.number().positive().default(30),
    })
    .prefault({}),
  github: z
    .object({
      // Labels only mirror run status onto GitHub issues. They are never read as input:
      // what the factory works on is decided locally, so nobody can feed it work by labelling an issue.
      status_labels: z.boolean().default(false),
      label_prefix: z.string().default("factory"),
      poll_interval_sec: z.number().int().min(30).default(120),
      max_starts_per_day: z.number().int().min(0).default(10),
    })
    .prefault({}),
});

export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

/** GitHub logins are case-insensitive. */
export function isTrustedAuthor(config: Pick<FactoryConfig, "trust">, login: string): boolean {
  if (config.trust.everyone) return true;
  const wanted = login.toLowerCase();
  return config.trust.authors.some((a) => a.replace(/^@/, "").toLowerCase() === wanted);
}

/**
 * Whether an issue's own text is the spec. An issue the factory opened itself (`factory new`) was
 * written from the operator's idea, so it is trusted whoever the gh login is. Comments on it by
 * others are not covered: they are judged by their own author.
 */
export function isTrustedIssue(config: Pick<FactoryConfig, "trust">, issue: { author: string; created_by_factory?: boolean }): boolean {
  return issue.created_by_factory === true || isTrustedAuthor(config, issue.author);
}
export type FactoryConfigInput = z.input<typeof factoryConfigSchema>;

/**
 * The model and effort for one agent. Model and effort resolve separately, so an entry that only
 * sets effort keeps the model it would otherwise get. Within the config, most specific wins:
 * high-risk lens, high-risk role, lens, role, then `default`/`effort`. Only what the config leaves
 * open comes from the recommendations (DEFAULT_MODELS), in the same order.
 */
export function resolveModel(
  config: Pick<FactoryConfig, "models">,
  target: { role: AgentRole; lens?: ReviewLens; risk?: "LOW" | "MEDIUM" | "HIGH" },
): { model: string; effort: Effort } {
  const highRisk = target.risk === "HIGH";
  type Layer = {
    default?: string;
    effort?: Effort;
    roles: Partial<Record<AgentRole, ModelSpec>>;
    reviews: Partial<Record<ReviewLens, ModelSpec>>;
    high_risk: Partial<Record<AgentRole | ReviewLens, ModelSpec>>;
  };
  const chain = (models: Layer): (ModelSpec | undefined)[] => [
    highRisk && target.lens ? models.high_risk[target.lens] : undefined,
    highRisk ? models.high_risk[target.role] : undefined,
    target.lens ? models.reviews[target.lens] : undefined,
    models.roles[target.role],
    { model: models.default, effort: models.effort },
  ];
  const all = [...chain(config.models), ...chain(DEFAULT_MODELS)];
  return { model: all.find((s) => s?.model)!.model!, effort: all.find((s) => s?.effort)!.effort! };
}
