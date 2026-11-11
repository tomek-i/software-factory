import { z } from "zod";
import { GATE_MODES } from "./states.js";

const gateMode = z.enum(GATE_MODES);

export const checkSchema = z.object({
  name: z.string().min(1),
  run: z.string().min(1),
  timeout_sec: z.number().int().positive().default(900),
});

export const HARD_RULE_TRIGGERS = ["new_dependency", "secrets_or_env_changes", "deletes_files_outside_scope"] as const;

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
  hard_rules: z
    .object({
      paths: z
        .array(z.string())
        .default(["**/auth/**", "**/migrations/**", ".github/workflows/**", "infra/**", ".factory/config.yaml"]),
      triggers: z.array(z.enum(HARD_RULE_TRIGGERS)).default([...HARD_RULE_TRIGGERS]),
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
  github: z
    .object({
      label: z.string().default("factory"),
      poll_interval_sec: z.number().int().min(30).default(120),
      max_starts_per_day: z.number().int().min(0).default(10),
    })
    .default({}),
});

export type FactoryConfig = z.infer<typeof factoryConfigSchema>;
export type FactoryConfigInput = z.input<typeof factoryConfigSchema>;
