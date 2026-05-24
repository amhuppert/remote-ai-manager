import { z } from "zod";

export const referenceDocumentSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  description: z.string(),
  createdAt: z.string(),
});
export type ReferenceDocument = z.infer<typeof referenceDocumentSchema>;
