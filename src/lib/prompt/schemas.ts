import { z } from "zod";
import { queueDeliveryTimingSchema } from "@/lib/agent-backends/descriptor";
import {
  documentFeedbackPayloadSchema,
  notepadFeedbackPayloadSchema,
} from "@/lib/conversations/message-content-schemas";
import {
  queuedMessageViewSchema,
  queueReviewActionSchema,
} from "@/lib/conversations/message-queue-schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import { collaborationAgentTwoRequestSchema } from "@/lib/workflows/collaboration/types";
export const runPromptRequestSchema = z
  .object({
    prompt: z.string().trim(),
    submittedPendingPromptText: z.string().optional(),
    modelSelection: backendModelSelectionSchema.optional(),
    modelId: z
      .never({ error: "Use the complete modelSelection instead of modelId." })
      .optional(),
    effort: z
      .never({
        error: "Put effort in the complete modelSelection parameters.",
      })
      .optional(),
    codexFastMode: z
      .never({
        error: "Put fast mode in the complete modelSelection parameters.",
      })
      .optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
    backend: agentBackendSchema.optional(),
    documentFeedback: documentFeedbackPayloadSchema.optional(),
    notepadFeedback: notepadFeedbackPayloadSchema.optional(),
    collab: z
      .object({
        negotiationRounds: z.number().int().min(1).max(20).optional(),
        autonomousResolutionThreshold: z
          .enum(["none", "minor", "major", "blocking"])
          .optional(),
        agentTwo: collaborationAgentTwoRequestSchema.optional(),
      })
      .optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.prompt.length > 0 ||
      (data.images && data.images.length > 0) ||
      (data.documentFeedback?.items.length ?? 0) > 0 ||
      (data.notepadFeedback?.items.length ?? 0) > 0,
    {
      message:
        "Either prompt text, at least one image, or review feedback is required",
    },
  );
export type RunPromptRequest = z.infer<typeof runPromptRequestSchema>;

export const pendingPromptRequestSchema = z.object({
  text: z.string().nullable(),
  expectedText: z.string().optional(),
});

export type PendingPromptRequest = z.infer<typeof pendingPromptRequestSchema>;

export const queueEnqueueRequestSchema = z
  .object({
    text: z.string().optional(),
    submittedPendingPromptText: z.string().optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
    documentFeedback: documentFeedbackPayloadSchema.optional(),
    notepadFeedback: notepadFeedbackPayloadSchema.optional(),
    modelSelection: backendModelSelectionSchema.optional(),
  })
  .strict()
  .refine(
    (data) =>
      (data.text?.trim().length ?? 0) > 0 ||
      (data.images?.length ?? 0) > 0 ||
      (data.documentFeedback?.items.length ?? 0) > 0 ||
      (data.notepadFeedback?.items.length ?? 0) > 0,
    {
      message:
        "Either message text, at least one image, or review feedback is required",
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

export const queueReviewRequestSchema = z
  .object({ action: queueReviewActionSchema })
  .strict();
export type QueueReviewRequest = z.infer<typeof queueReviewRequestSchema>;

export const queueReviewResponseSchema = z.object({
  resolved: z.literal(true),
  id: z.string(),
  action: queueReviewActionSchema,
});
export type QueueReviewResponse = z.infer<typeof queueReviewResponseSchema>;
