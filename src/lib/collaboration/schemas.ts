import { z } from "zod";

export const collaborationEnvelopeSchema = z.object({
  workflowId: z.string(),
  workflowType: z.string(),
  status: z.enum(["running", "paused", "completed", "failed"]),
  phase: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  errorSummary: z.string().optional(),
  pause: z
    .object({
      pauseKind: z.string(),
      gateKind: z.string(),
      resumeToken: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  featureSnapshot: z.unknown(),
});

export const collaborationListResponseSchema = z.object({
  envelopes: z.array(collaborationEnvelopeSchema),
});

export type CollaborationEnvelope = z.infer<typeof collaborationEnvelopeSchema>;

export const collaborationStartResponseSchema = z.object({
  workflowId: z.string(),
  status: z.literal("started"),
  statusUrl: z.string(),
});

export const collaborationResumeResponseSchema = z.object({
  workflowId: z.string(),
  status: z.literal("resumed"),
});

export const collaborationStopResponseSchema = z.object({
  workflowId: z.string(),
  status: z.literal("stopped"),
});
