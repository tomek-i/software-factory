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

export const REVIEW_LENSES = ["code", "security", "docs", "ux", "ui"] as const;
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

export const factoryConfigSchema = z.object({
  version: z.literal(1),
  project: z
    .object({
      name: z.string().optional(),
      default_branch: z.string().default("main"),
    })
    .default({}),
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
    })
    .default({}),
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
    .default({}),
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
    .default({}),
  loops: z
    .object({
      max_build_iterations: z.number().int().min(1).default(5),
      max_review_rounds: z.number().int().min(1).default(3),
      max_critic_rounds: z.number().int().min(1).default(2),
    })
    .default({}),
  reviews: z
    .object({
      always: z.array(z.enum(REVIEW_LENSES)).default(["code", "security", "docs"]),
      ui: z.array(z.enum(REVIEW_LENSES)).default(["ux", "ui"]),
    })
    .default({}),
  models: z
    .object({
      default: z.string().min(1).default("opus"),
      // Unset means Claude Code's own default effort.
      effort: z.enum(EFFORT_LEVELS).optional(),
      roles: z.record(z.enum(AGENT_ROLES), modelSpec).default({}),
      // Per review lens; a lens without an entry uses roles.reviewer.
      reviews: z.record(z.enum(REVIEW_LENSES), modelSpec).default({}),
      // Applied on top of everything else when triage rated the issue RISK: HIGH.
      high_risk: z.record(z.enum([...AGENT_ROLES, ...REVIEW_LENSES]), modelSpec).default({}),
    })
    .default({}),
  concurrency: z
    .object({
      max_runs: z.number().int().min(1).default(2),
    })
    .default({}),
  // Whose issue text and comments the agents may treat as the spec. Anything else is handled as
  // untrusted data and triage always waits for a human before it can lead to a build.
  trust: z
    .object({
      authors: z.array(z.string().min(1)).default([]),
      // For private repos where only approved people can open issues.
      everyone: z.boolean().default(false),
    })
    .default({}),
  github: z
    .object({
      // Labels only mirror run status onto GitHub issues. They are never read as input:
      // what the factory works on is decided locally, so nobody can feed it work by labelling an issue.
      status_labels: z.boolean().default(false),
      label_prefix: z.string().default("factory"),
      poll_interval_sec: z.number().int().min(30).default(120),
      max_starts_per_day: z.number().int().min(0).default(10),
    })
    .default({}),
});

export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

/** GitHub logins are case-insensitive. */
export function isTrustedAuthor(config: Pick<FactoryConfig, "trust">, login: string): boolean {
  if (config.trust.everyone) return true;
  const wanted = login.toLowerCase();
  return config.trust.authors.some((a) => a.replace(/^@/, "").toLowerCase() === wanted);
}
export type FactoryConfigInput = z.input<typeof factoryConfigSchema>;

/**
 * The model and effort for one agent. Model and effort resolve separately, so an entry that only
 * sets effort keeps the model it would otherwise get. Most specific wins: high-risk lens, high-risk
 * role, lens, role, then the defaults.
 */
export function resolveModel(
  config: Pick<FactoryConfig, "models">,
  target: { role: AgentRole; lens?: ReviewLens; risk?: "LOW" | "MEDIUM" | "HIGH" },
): { model: string; effort?: Effort } {
  const { models } = config;
  const highRisk = target.risk === "HIGH";
  const chain: (ModelSpec | undefined)[] = [
    highRisk && target.lens ? models.high_risk[target.lens] : undefined,
    highRisk ? models.high_risk[target.role] : undefined,
    target.lens ? models.reviews[target.lens] : undefined,
    models.roles[target.role],
  ];
  const model = chain.find((s) => s?.model)?.model ?? models.default;
  const effort = chain.find((s) => s?.effort)?.effort ?? models.effort;
  return effort ? { model, effort } : { model };
}
