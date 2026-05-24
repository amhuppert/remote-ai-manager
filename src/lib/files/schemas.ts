import { z } from "zod";

export const fileItemSchema = z.object({
  path: z.string(),
});
export type FileItem = z.infer<typeof fileItemSchema>;

export const projectFilesResponseSchema = z.object({
  items: z.array(fileItemSchema),
  truncated: z.boolean(),
  scannedCount: z.number().int().nonnegative(),
});
