import { z } from "zod";

/**
 * One repo in the factory's per-user project list (`projects.json`). Loose, so a field a newer
 * factory adds is kept when an older one rewrites the file.
 */
export const registryEntrySchema = z.looseObject({
  path: z.string().min(1),
  name: z.string().min(1),
  added_at: z.string(),
});

export const registryFileSchema = z.looseObject({ version: z.literal(1), projects: z.array(registryEntrySchema) });

export type RegistryEntry = z.infer<typeof registryEntrySchema>;
