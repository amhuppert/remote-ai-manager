import { z } from "zod";

const presetInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  badge: z.string(),
  files: z.array(z.string()),
  installed: z.boolean(),
});

export const presetsResponseSchema = z.object({
  presets: z.array(presetInfoSchema),
});

export const installPresetResponseSchema = z.object({
  installedFiles: z.array(z.string()),
  configUpdated: z.boolean(),
});
