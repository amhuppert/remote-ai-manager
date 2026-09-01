import { z } from "zod";

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

const managedCandidateSchema = z
  .object({
    protocol: z.literal("native-sdd-delivery-candidate/v3"),
    schemaVersion: z.literal(3),
    specId: z.string().min(1),
    attemptId: z.string().min(1),
    candidateId: z.string().min(1),
    pinnedRevisionId: z.string().min(1),
    draftRevision: z.number().int().positive(),
    workflowDefinition: z
      .object({
        id: z.string().min(1),
        revision: z.number().int().positive(),
        definitionHash: z.string().min(1),
      })
      .strict(),
    binding: z
      .object({
        dispositions: z.array(managedBindingDispositionSchema),
        claims: z.array(managedClaimSchema),
      })
      .strict(),
    bindingHash: z.string().min(1),
  })
  .strict();

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
        claims: z.array(managedClaimSchema),
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

export interface ManagedWorkflowDefinitionPolicy {
  list(
    projectPath: string,
    workflowIds: readonly string[],
  ): Promise<ReadonlyMap<string, NativeSddWorkflowManagementCompact>>;
  get(
    projectPath: string,
    workflowId: string,
  ): Promise<NativeSddWorkflowManagementDetail | null>;
}

export function managedWorkflowReadOnlyInstruction(
  management: NativeSddWorkflowManagementCompact,
): string {
  if (management.lifecycle === "launched" && management.executionHref) {
    return "Open the execution to inspect the launched candidate.";
  }
  if (
    management.lifecycle === "in_review" ||
    management.lifecycle === "approved"
  ) {
    return "Reopen the delivery plan before editing its workflow definition.";
  }
  return "Open the spec to inspect this delivery candidate.";
}
