import { z } from "zod";

/**
 * The capture agent's plan: which pages to screenshot and a short walkthrough to record. The engine
 * runs it with Playwright. It is data, never code: the walkthrough is a fixed set of declarative
 * steps, and every path is same-origin, so an agent (possibly steered by issue text) cannot run
 * script in the browser or point it at another site.
 */

/** Screenshot widths: desktop and phone. */
export const CAPTURE_WIDTHS = [1440, 390] as const;

export const MAX_CAPTURE_PAGES = 10;
export const MAX_WALKTHROUGH_STEPS = 30;
export const MAX_STEP_WAIT_MS = 10_000;

/** A file-name-safe name: it becomes part of the screenshot's file name. */
const name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "use 1-40 lowercase letters, digits and dashes, starting with a letter or digit");

/**
 * A path on the app's own origin: starts with one `/`, no scheme, host, backslash or control
 * characters. `//evil.example` would be protocol-relative, so it is refused too.
 */
export const samePath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => p.startsWith("/") && !p.startsWith("//") && !/[\\\s]/.test(p) && ![...p].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), {
    message: "must be a path on the app's own origin, starting with a single / (e.g. /settings?tab=a)",
  });

const selector = z.string().min(1).max(300);

/**
 * What a narrated walkthrough says while this step runs (and the steps after it, until the next
 * step that says something). Spoken aloud and published in the video, so it is plain text.
 */
const say = z
  .string()
  .min(1)
  .max(300)
  .refine((t) => ![...t].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f), { message: "must be one line of plain text" })
  .optional();

export const walkthroughStepSchema = z
  .discriminatedUnion("action", [
    z.object({ action: z.literal("goto"), path: samePath, say }).strict(),
    z.object({ action: z.literal("click"), selector: selector.optional(), text: z.string().min(1).max(200).optional(), say }).strict(),
    z.object({ action: z.literal("fill"), selector, value: z.string().max(500), say }).strict(),
    z.object({ action: z.literal("wait"), ms: z.number().int().min(0).max(MAX_STEP_WAIT_MS), say }).strict(),
    z.object({ action: z.literal("screenshot"), name, say }).strict(),
  ])
  .superRefine((step, ctx) => {
    if (step.action === "click" && (step.selector === undefined) === (step.text === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "click needs exactly one of selector or text" });
    }
  });
export type WalkthroughStep = z.infer<typeof walkthroughStepSchema>;

export const capturePageSchema = z
  .object({
    name,
    path: samePath,
    /** `new`: the change adds this screen, so there is nothing to compare it with. */
    screen: z.enum(["new", "existing"]),
    why: z.string().max(300).optional(),
  })
  .strict();
export type CapturePage = z.infer<typeof capturePageSchema>;

export const capturePlanSchema = z
  .object({
    pages: z.array(capturePageSchema).min(1).max(MAX_CAPTURE_PAGES),
    walkthrough: z.array(walkthroughStepSchema).max(MAX_WALKTHROUGH_STEPS).default([]),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const names = plan.pages.map((p) => p.name);
    const twice = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (twice.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pages"], message: `page names must be unique: ${twice.join(", ")}` });
    const shots = plan.walkthrough.flatMap((s) => (s.action === "screenshot" ? [s.name] : []));
    const repeated = [...new Set(shots.filter((n, i) => shots.indexOf(n) !== i))];
    if (repeated.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["walkthrough"], message: `screenshot names must be unique: ${repeated.join(", ")}` });
  });
export type CapturePlan = z.infer<typeof capturePlanSchema>;

/**
 * The plan in a capture.md body: exactly one ```json block under `## Plan`. Returns the plan or
 * the problems, worded for the agent's retry.
 */
export function parseCapturePlan(body: string): { plan?: CapturePlan; problems: string[] } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^#{2,3}\s*plan\s*:?\s*$/i.test(l.trim()));
  if (start === -1) return { problems: ["## Plan with a ```json block is missing"] };
  const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l));
  const text = lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) return { problems: ["## Plan must contain exactly one ```json block"] };
  let data: unknown;
  try {
    data = JSON.parse(blocks[0]![1]!);
  } catch (err) {
    return { problems: [`plan JSON is invalid: ${(err as Error).message}`] };
  }
  const result = capturePlanSchema.safeParse(data);
  if (!result.success) return { problems: result.error.issues.map((i) => `plan.${i.path.join(".")}: ${i.message}`) };
  return { plan: result.data, problems: [] };
}
