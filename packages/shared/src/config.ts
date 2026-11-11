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
      url: z.string().default("http://localhost:{port}"),
      port_env: z.string().default("PORT"),
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
        .array(z.string())
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
      default: z.string().default("opus"),
      roles: z.record(z.enum(AGENT_ROLES), z.string()).default({}),
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
