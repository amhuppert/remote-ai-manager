import { z } from "zod";
import { queueDeliveryTimingSchema } from "@/lib/agent-backends/descriptor";
import { documentFeedbackPayloadSchema } from "@/lib/conversations/message-content-schemas";
import { queuedMessageViewSchema } from "@/lib/conversations/message-queue-schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
export const runPromptRequestSchema = z
  .object({
    prompt: z.string().trim(),
    submittedPendingPromptText: z.string().optional(),
    modelId: z.string().trim().min(1).optional(),
    effort: z.string().trim().min(1).optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
    backend: agentBackendSchema.optional(),
    documentFeedback: documentFeedbackPayloadSchema.optional(),
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
    (data) =>
      data.prompt.length > 0 ||
      (data.images && data.images.length > 0) ||
      (data.documentFeedback?.items.length ?? 0) > 0,
    {
      message:
        "Either prompt text, at least one image, or document feedback is required",
    },
  );
export type RunPromptRequest = z.infer<typeof runPromptRequestSchema>;

export const pendingPromptRequestSchema = z.object({
  text: z.string().nullable(),
  expectedText: z.string().optional(),
});

export const queueEnqueueRequestSchema = z
  .object({
    text: z.string().optional(),
    submittedPendingPromptText: z.string().optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
    documentFeedback: documentFeedbackPayloadSchema.optional(),
  })
  .refine(
    (data) =>
      (data.text?.trim().length ?? 0) > 0 ||
      (data.images?.length ?? 0) > 0 ||
      (data.documentFeedback?.items.length ?? 0) > 0,
    {
      message:
        "Either message text, at least one image, or document feedback is required",
    },
  );
export type QueueEnqueueRequest = z.infer<typeof queueEnqueueRequestSchema>;

export const queueEnqueueResponseSchema = z.object({
  queued: z.literal(true),
  message: queuedMessageViewSchema,
  deliveryTiming: queueDeliveryTimingSchema,
});
export type QueueEnqueueResponse = z.infer<typeof queueEnqueueResponseSchema>;

export const queueCancellationResponseSchema = z.object({
  cancelled: z.literal(true),
  id: z.string(),
});
export type QueueCancellationResponse = z.infer<
  typeof queueCancellationResponseSchema
>;
