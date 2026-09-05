import { z } from "zod";
import { deliveryPlanCandidateRecordSchema } from "@/lib/specs/delivery-plan";

export const managedWorkflowDefinitionLifecycleSchema = z.enum([
  "draft",
  "in_review",
  "approved",
  "launched",
  "superseded",
  "abandoned",
]);
export type ManagedWorkflowDefinitionLifecycle = z.infer<
  typeof managedWorkflowDefinitionLifecycleSchema
>;

export const nativeSddWorkflowManagementCompactSchema = z
  .object({
    kind: z.literal("native_sdd_delivery"),
    specId: z.string().min(1),
    specSlug: z.string().min(1),
    specName: z.string().min(1),
    attemptId: z.string().min(1),
    pinnedRevisionId: z.string().min(1),
    pinnedRevisionNumber: z.number().int().positive(),
    lifecycle: managedWorkflowDefinitionLifecycleSchema,
    editable: z.boolean(),
    isCurrentDefinition: z.boolean(),
    specHref: z.string().min(1),
    builderHref: z.string().min(1),
    executionHref: z.string().min(1).nullable(),
  })
  .strict();
export type NativeSddWorkflowManagementCompact = z.infer<
  typeof nativeSddWorkflowManagementCompactSchema
>;

const managedBindingDispositionSchema = z
  .object({
    criterionElementId: z.string().min(1),
    disposition: z.enum([
      "in_scope",
      "deferred",
      "waived",
      "delivered_elsewhere",
      "reaffirmed",
      "pending_reaffirmation",
    ]),
    deliveredByExecutionId: z.string().min(1).nullable(),
  })
  .strict();

const managedClaimSchema = z
  .object({
    contextId: z.string().min(1),
    criterionElementIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const managedCriterionRowSchema = managedBindingDispositionSchema.extend({
  handle: z.string().min(1),
  text: z.string(),
  contextIds: z.array(z.string().min(1)),
});

const managedCommentSchema = z
  .object({
    id: z.string().min(1),
    contextId: z.string().min(1),
    body: z.string().min(1),
    author: z.unknown(),
    createdAt: z.string().min(1),
    orphaned: z.boolean(),
  })
  .strict();

const managedCandidateSchema = deliveryPlanCandidateRecordSchema;

const managedApprovalSchema = z
  .object({
    candidateId: z.string().min(1),
    candidateHash: z.string().min(1),
    snapshotId: z.string().min(1),
    approvedAt: z.string().min(1),
    approvedBy: z.unknown(),
  })
  .strict();

export const nativeSddWorkflowManagementDetailSchema =
  nativeSddWorkflowManagementCompactSchema.extend({
    bindingRevision: z.number().int().positive(),
    deltaBasisExecutionId: z.string().min(1).nullable(),
    binding: z
      .object({
        dispositions: z.array(managedBindingDispositionSchema),
      })
      .strict(),
    dispositionCounts: z.record(z.string(), z.number().int().nonnegative()),
    unresolvedItems: z.array(managedCriterionRowSchema),
    criterionRows: z.array(managedCriterionRowSchema),
    claims: z.array(managedClaimSchema),
    comments: z.array(managedCommentSchema),
    nextAct: z.string().nullable(),
    currentCandidate: managedCandidateSchema.nullable(),
    currentCandidateHash: z.string().min(1).nullable(),
    currentApproval: managedApprovalSchema.nullable(),
    approvedBaseline: z
      .object({
        snapshotId: z.string().min(1),
        candidateId: z.string().min(1),
        candidateHash: z.string().min(1),
        approvedAt: z.string().min(1),
        workflowDefinition: z
          .object({
            id: z.string().min(1),
            revision: z.number().int().positive(),
            definitionHash: z.string().min(1),
          })
          .strict(),
      })
      .strict()
      .nullable(),
    changes: z
      .object({
        workflowSettings: z.boolean(),
        contexts: z.boolean(),
        tasks: z.boolean(),
        edges: z.boolean(),
        layout: z.boolean(),
        dispositions: z.boolean(),
        claims: z.boolean(),
      })
      .strict(),
    capabilities: z
      .object({
        canPropose: z.boolean(),
        canSignOff: z.boolean(),
        canReopen: z.boolean(),
        canAbandon: z.boolean(),
        canLaunch: z.boolean(),
        refusals: z.record(z.string(), z.string()),
      })
      .strict(),
  });
export type NativeSddWorkflowManagementDetail = z.infer<
  typeof nativeSddWorkflowManagementDetailSchema
>;
