import { z } from "zod";

/** One repo in the factory's per-user project list (`projects.json`). */
export const registryEntrySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  added_at: z.string(),
});

export const registryFileSchema = z.object({ version: z.literal(1), projects: z.array(registryEntrySchema) });

export type RegistryEntry = z.infer<typeof registryEntrySchema>;
