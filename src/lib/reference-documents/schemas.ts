import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

export const referenceDocumentSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    filePath: z.string(),
    description: z.string(),
    createdAt: z.string(),
  }),
  "referenceDocumentSchema",
);
export type ReferenceDocument = z.infer<typeof referenceDocumentSchema>;
