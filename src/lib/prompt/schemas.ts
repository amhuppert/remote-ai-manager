import { z } from "zod";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
export const runPromptRequestSchema = z
  .object({
    prompt: z.string().trim(),
    modelId: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
    backend: agentBackendSchema.optional(),
    collab: z
      .object({
        negotiationRounds: z.number().int().min(1).max(20).optional(),
        autonomousResolutionThreshold: z
          .enum(["none", "minor", "major", "blocking"])
          .optional(),
      })
      .optional(),
  })
  .refine(
    (data) => data.prompt.length > 0 || (data.images && data.images.length > 0),
    { message: "Either prompt text or at least one image is required" },
  );
export type RunPromptRequest = z.infer<typeof runPromptRequestSchema>;

export const pendingPromptRequestSchema = z.object({
  text: z.string().nullable(),
});
