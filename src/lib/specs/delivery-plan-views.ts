import { z } from "zod";

import {
  deliveryPlanBindingSchema,
  deliveryPlanCriterionDispositionSchema,
  deliveryPlanDocumentSchema,
  finalizedDeliveryPlanApprovalSchema,
  finalizedDeliveryPlanCandidateIdentitySchema,
  finalizedDeliveryPlanDocumentSchema,
} from "./delivery-plan";
import { workflowDefinitionMutationSchema } from "@/lib/workflow-graph/definition-schemas";
import {
  lintFindingSchema,
  specStartedExecutionViewSchema,
} from "./view-schemas";

const nonNegativeInt = z.number().int().nonnegative();

export const deliveryPlanHealthViewSchema = z
  .object({
    total: nonNegativeInt,
    blocking: nonNegativeInt,
    counts: z.array(
      z
        .object({
          severity: lintFindingSchema.shape.severity,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    findings: z.array(lintFindingSchema),
  })
  .strict();
export type DeliveryPlanHealthView = z.infer<
  typeof deliveryPlanHealthViewSchema
>;

export const deliveryPlanAttemptViewSchema = z
  .object({
    id: z.string().min(1),
    specSlug: z.string().min(1),
    status: z.enum([
      "draft",
      "proposed",
      "approved",
      "parked",
      "launched",
      "abandoned",
    ]),
    draftRevision: z.number().int().positive(),
    pinnedRevisionId: z.string().min(1),
    deltaBasisExecutionId: z.string().min(1).nullable(),
    proposedSnapshotId: z.string().min(1).nullable(),
    candidateId: z.string().min(1).nullable(),
    candidateHash: z.string().min(1).nullable(),
    launchedExecutionId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type DeliveryPlanAttemptView = z.infer<
  typeof deliveryPlanAttemptViewSchema
>;

export const deliveryPlanSnapshotViewSchema = z
  .object({
    id: z.string().min(1),
    draftRevision: z.number().int().positive(),
    candidateId: z.string().min(1),
    candidateHash: z.string().min(1),
    proposedAt: z.string().min(1),
  })
  .strict();
export type DeliveryPlanSnapshotView = z.infer<
  typeof deliveryPlanSnapshotViewSchema
>;

export const deliveryPlanNextActSchema = z
  .object({
    actor: z.enum(["agent", "human"]),
    command: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type DeliveryPlanNextAct = z.infer<typeof deliveryPlanNextActSchema>;

export const deliveryPlanPrelaunchViewSchema = z
  .object({
    parkedAt: z.string().min(1),
    parkedBy: z
      .object({ kind: z.enum(["human", "agent", "system"]) })
      .passthrough(),
    reason: z.string().nullable(),
    approvedAtPark: z.boolean(),
    parkedCandidateId: z.string().min(1),
    parkedCandidateHash: z.string().min(1),
    currentCandidateId: z.string().min(1).nullable(),
    currentCandidateHash: z.string().min(1).nullable(),
    candidateChanged: z.boolean(),
  })
  .strict();

export const deliveryPlanUnresolvedViewSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    disposition: deliveryPlanCriterionDispositionSchema,
    resolution: z.string().min(1),
  })
  .strict();
export type DeliveryPlanUnresolvedView = z.infer<
  typeof deliveryPlanUnresolvedViewSchema
>;

export const deliveryPlanViewSchema = z
  .object({
    attempt: deliveryPlanAttemptViewSchema,
    approval: finalizedDeliveryPlanApprovalSchema.nullable(),
    prelaunch: deliveryPlanPrelaunchViewSchema.nullable(),
    document: finalizedDeliveryPlanDocumentSchema,
    health: deliveryPlanHealthViewSchema,
    dispositionCounts: z.array(
      z
        .object({
          disposition: deliveryPlanCriterionDispositionSchema,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    unresolved: z.array(deliveryPlanUnresolvedViewSchema),
    snapshots: z.array(deliveryPlanSnapshotViewSchema),
    nextAct: deliveryPlanNextActSchema,
  })
  .strict();
export type DeliveryPlanView = z.infer<typeof deliveryPlanViewSchema>;

export const deliveryPlanMutationViewSchema = deliveryPlanViewSchema
  .extend({
    previousHealth: z
      .object({ total: nonNegativeInt, blocking: nonNegativeInt })
      .strict()
      .nullable(),
    invalidatedApproval: z
      .object({
        snapshotId: z.string().min(1),
        candidateHash: z.string().min(1),
      })
      .strict()
      .nullable(),
    executionStartAdmission: z
      .object({
        dial: z.enum(["gate", "notify", "off", "combined-approval"]),
        basis: z.enum([
          "human_approval",
          "notify_policy",
          "off_policy",
          "import",
        ]),
        admissionId: z.string().min(1),
        approvalId: z.string().min(1).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DeliveryPlanMutationView = z.infer<
  typeof deliveryPlanMutationViewSchema
>;

export const deliveryPlanEditRequestSchema = z
  .object({
    expectedDraftRevision: z.number().int().positive(),
    document: deliveryPlanDocumentSchema,
  })
  .strict();
export type DeliveryPlanEditRequest = z.infer<
  typeof deliveryPlanEditRequestSchema
>;
export const deliveryPlanOpenRequestSchema = z
  .object({ seedFromLast: z.boolean() })
  .strict();
export const deliveryPlanReopenRequestSchema = z
  .object({ reason: z.string().min(1) })
  .strict();
export const deliveryPlanSignOffRequestSchema =
  finalizedDeliveryPlanCandidateIdentitySchema;
/**
 * Reaffirmation carries the draft revision the human reviewed. Without it the
 * act would land on whatever the draft became between the read and the click,
 * which is exactly the judgment the reaffirmation is supposed to record.
 */
export const deliveryPlanReaffirmRequestSchema = z
  .object({
    criterionElementId: z.string().min(1),
    expectedDraftRevision: z.number().int().positive(),
  })
  .strict();
export const deliveryPlanCommentRequestSchema = z
  .object({
    contextId: z.string().min(1).max(120),
    body: z.string().min(1).max(4000),
  })
  .strict();
export const deliveryPlanPreviewStageSchema = z.enum(["draft", "proposed"]);
export type DeliveryPlanPreviewStage = z.infer<
  typeof deliveryPlanPreviewStageSchema
>;
export const deliveryPlanPreviewRequestSchema = z
  .object({
    stage: deliveryPlanPreviewStageSchema,
    expectedDraftRevision: z.number().int().positive().optional(),
  })
  .strict();

export const deliveryPlanPreviewViewSchema = z
  .object({
    stage: deliveryPlanPreviewStageSchema,
    attemptId: z.string().min(1),
    specSlug: z.string().min(1),
    draftRevision: z.number().int().positive(),
    pinnedRevisionId: z.string().min(1),
    candidateHash: z.string().min(1).nullable(),
    snapshotId: z.string().min(1).nullable(),
    candidateId: z.string().min(1).nullable(),
    approvable: z.boolean(),
    approvability: z.string().min(1),
    launch: workflowDefinitionMutationSchema,
    binding: deliveryPlanBindingSchema,
  })
  .strict();
export type DeliveryPlanPreviewView = z.infer<
  typeof deliveryPlanPreviewViewSchema
>;

/**
 * The `start-execution` receipt. A start either launches one identified
 * candidate or parks one; no legacy shape exists. Both the CLI and Spec Studio
 * read the same union so a launch surface cannot drift from what the route
 * answers.
 */
const deliveryPlanReceiptCandidateSchema = z
  .object({
    attemptId: z.string().min(1),
    candidateId: z.string().min(1),
    candidateHash: z.string().min(1),
  })
  .strict();
const launchedDeliveryPlanReceiptSchema = deliveryPlanReceiptCandidateSchema
  .extend({
    workflowExecutionId: z.string().min(1),
    resolvedDefinitionHash: z.string().min(1),
  })
  .strict();
const parkedDeliveryPlanReceiptSchema = deliveryPlanReceiptCandidateSchema
  .extend({ nextAct: deliveryPlanNextActSchema })
  .strict();
export const launchedSpecExecutionReceiptSchema = z
  .object({
    execution: specStartedExecutionViewSchema,
    launch: workflowDefinitionMutationSchema,
    deliveryPlan: launchedDeliveryPlanReceiptSchema,
  })
  .strict();
export type LaunchedSpecExecutionReceipt = z.infer<
  typeof launchedSpecExecutionReceiptSchema
>;
export const specStartExecutionReceiptSchema = z.union([
  launchedSpecExecutionReceiptSchema,
  z.object({ parked: parkedDeliveryPlanReceiptSchema }).strict(),
]);

export const deliveryPlanDocumentDiffSchema = z
  .object({ launchChanged: z.boolean(), bindingChanged: z.boolean() })
  .strict();
export type DeliveryPlanDocumentDiff = z.infer<
  typeof deliveryPlanDocumentDiffSchema
>;
export const deliveryPlanSnapshotDiffViewSchema = z
  .object({
    from: deliveryPlanSnapshotViewSchema,
    to: deliveryPlanSnapshotViewSchema,
    diff: deliveryPlanDocumentDiffSchema,
  })
  .strict();
export type DeliveryPlanSnapshotDiffView = z.infer<
  typeof deliveryPlanSnapshotDiffViewSchema
>;
