import { z } from "zod";
import { specAcceptanceReviewSchema, specExecutionRowSchema } from "./schemas";

export const acceptanceReviewRequestSchema = z
  .object({
    revisionId: z.string().min(1),
    expectedContentHash: z.string().nullable(),
    expectedReviewId: z.string().nullable(),
    criterionIds: z.array(z.string().min(1)).min(1),
    decision: z.enum(["satisfied", "waived", "revoked"]),
    note: z.string().default(""),
  })
  .strict();
export type AcceptanceReviewRequest = z.infer<
  typeof acceptanceReviewRequestSchema
>;

export const deliveryApprovalRequestSchema = z
  .object({
    revisionId: z.string().min(1),
    executionId: z.string().min(1),
    expectedContentHash: z.string().nullable(),
    expectedReviewId: z.string().nullable(),
    waiveRemaining: z.boolean(),
    note: z.string().default(""),
  })
  .strict();
export type DeliveryApprovalRequest = z.infer<
  typeof deliveryApprovalRequestSchema
>;

export const deliveryContinuationRequestSchema = z
  .object({
    revisionId: z.string().min(1),
    expectedExecutionId: z.string().nullable(),
    mode: z.enum(["session", "workflow", "external"]),
    sessionName: z.string().min(1).optional(),
    workflowExecutionId: z.string().min(1).optional(),
    commitRefs: z.array(z.string().min(1)).default([]),
    note: z.string().default(""),
  })
  .strict();
export type DeliveryContinuationRequest = z.infer<
  typeof deliveryContinuationRequestSchema
>;

export const deliveryReplacementRequestSchema =
  deliveryContinuationRequestSchema.pick({
    revisionId: true,
    expectedExecutionId: true,
    note: true,
  });
export type DeliveryReplacementRequest = z.infer<
  typeof deliveryReplacementRequestSchema
>;

export const deliveryReviewViewSchema = z.object({
  revisionId: z.string(),
  revisionNumber: z.number(),
  contentHash: z.string().nullable(),
  lastReviewId: z.string().nullable(),
  execution: specExecutionRowSchema.nullable(),
  delivered: z.boolean(),
  criteria: z.array(
    z.object({
      id: z.string(),
      handle: z.string(),
      text: z.string(),
      requirement: z.string(),
      inScope: z.boolean(),
      outcome: z.enum([
        "proven",
        "satisfied",
        "waived",
        "needs_review",
        "excluded",
        "delivered",
        "delivered_externally",
      ]),
      automated: z.array(z.string()),
      humanReview: specAcceptanceReviewSchema.nullable(),
    }),
  ),
  approvalGranted: z.boolean(),
  requiresApproval: z.boolean(),
  blockers: z.array(
    z.object({
      criterionId: z.string(),
      reason: z.string(),
      kind: z.enum(["approval", "criterion", "execution"]),
    }),
  ),
  history: z.array(specAcceptanceReviewSchema),
});
export type DeliveryReviewView = z.infer<typeof deliveryReviewViewSchema>;

export const deliveryReadinessSchema = z
  .object({
    revisionId: z.string(),
    executionId: z.string().nullable(),
    approvalGranted: z.boolean(),
    totalInScope: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    blockers: deliveryReviewViewSchema.shape.blockers,
  })
  .strict();
