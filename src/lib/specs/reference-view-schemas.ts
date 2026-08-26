import { z } from "zod";

import {
  deliveryDisplaySchema,
  specPhaseProjectionSchema,
} from "./phase-view-schemas";
import {
  actorProvenanceSchema,
  specApprovalRowSchema,
  specAssumptionCitationSchema,
  specAssumptionDispositionSchema,
  specAttentionRecordPresentationSchema,
  specEvidenceRowSchema,
  specProofVerdictRowSchema,
  specQuestionStatusSchema,
  specRevisionElementSchema,
  specRevisionSchema,
  specSchema,
  specWaiverRowSchema,
} from "./schemas";

export const specQuestionViewSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    handle: z.string().min(1),
    elementId: z.string().nullable(),
    text: z.string(),
    recordVersion: z.number().int().positive(),
    status: specQuestionStatusSchema,
    answer: z.string().nullable(),
    answeredAt: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
    provenance: actorProvenanceSchema.nullable(),
    presentation: specAttentionRecordPresentationSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type SpecQuestionView = z.infer<typeof specQuestionViewSchema>;

export const specAssumptionViewSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    handle: z.string().min(1),
    elementId: z.string().nullable(),
    text: z.string(),
    recordVersion: z.number().int().positive(),
    disposition: specAssumptionDispositionSchema,
    disposedAt: z.string().nullable(),
    withdrawnAt: z.string().nullable(),
    proposedBy: actorProvenanceSchema.nullable(),
    supersedesHandle: z.string().min(1).nullable(),
    supersededByHandle: z.string().min(1).nullable(),
    currentDraftCitations: z
      .object({
        revisionId: z.string().min(1),
        citationVersion: z.number().int().positive(),
        citationHash: z.string().length(64),
        citations: z.array(
          specAssumptionCitationSchema
            .extend({ elementHandle: z.string().min(1).nullable() })
            .strict(),
        ),
      })
      .strict()
      .nullable(),
    presentation: specAttentionRecordPresentationSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type SpecAssumptionView = z.infer<typeof specAssumptionViewSchema>;

const elementCountsSchema = z
  .object({
    requirements: z.number().int().nonnegative(),
    criteria: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    tasks: z.number().int().nonnegative(),
  })
  .strict();

const linkedWorkRollupSchema = z
  .object({
    tickets: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    workflowExecutions: z.number().int().nonnegative(),
    mergeJobs: z.number().int().nonnegative(),
  })
  .strict();

export const specSummaryViewSchema = z
  .object({
    spec: specSchema,
    phase: specPhaseProjectionSchema,
    currentRevision: specRevisionSchema.nullable(),
    counts: elementCountsSchema,
    pendingApprovalCount: z.number().int().nonnegative(),
    approvalState: z.enum(["complete", "pending"]),
    delivery: deliveryDisplaySchema,
    linkedWork: linkedWorkRollupSchema,
    /** The status view's import provenance, carried so an inventory row can
     * mark an imported spec without loading the whole detail. Required for the
     * same reason the status field is. */
    imported: z.boolean(),
  })
  .strict();
export type SpecSummaryView = z.infer<typeof specSummaryViewSchema>;

export const specInventoryViewSchema = z
  .object({ specs: z.array(specSummaryViewSchema) })
  .strict();
export type SpecInventoryView = z.infer<typeof specInventoryViewSchema>;

const specPickerRevisionElementSchema = specRevisionElementSchema
  .extend({ handle: z.string().min(1).nullable().optional() })
  .strict();

export const specPickerDetailViewSchema = z.object({
  spec: specSchema,
  currentRevision: z
    .object({
      revision: specRevisionSchema,
      elements: z.array(specPickerRevisionElementSchema),
    })
    .nullable(),
  questions: z.array(specQuestionViewSchema).default([]),
  assumptions: z.array(specAssumptionViewSchema).default([]),
});
export type SpecPickerDetailView = z.infer<typeof specPickerDetailViewSchema>;

const evidenceStateSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    evidence: z.array(specEvidenceRowSchema),
    verdicts: z.array(specProofVerdictRowSchema),
    waiver: specWaiverRowSchema.nullable(),
  })
  .strict();

export const specElementReferenceStateSchema = z
  .object({
    observedRevision: z.number().int().positive(),
    observedPayloadHash: z.string().min(1).nullable(),
    latestContainingRevision: z.number().int().positive(),
    latestPayloadHash: z.string().min(1),
  })
  .strict();
export type SpecElementReferenceState = z.infer<
  typeof specElementReferenceStateSchema
>;

export const specElementViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    revision: specRevisionSchema,
    handle: z.string().min(1),
    element: specRevisionElementSchema,
    approvals: z.array(specApprovalRowSchema),
    evidenceState: z.array(evidenceStateSchema),
    referenceState: specElementReferenceStateSchema.nullable(),
  })
  .strict();
export type SpecElementView = z.infer<typeof specElementViewSchema>;

export const specQuestionElementViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("question"),
    handle: z.string().min(1),
    question: specQuestionViewSchema,
  })
  .strict();
export type SpecQuestionElementView = z.infer<
  typeof specQuestionElementViewSchema
>;

export const specAssumptionElementViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("assumption"),
    handle: z.string().min(1),
    assumption: specAssumptionViewSchema,
  })
  .strict();
export type SpecAssumptionElementView = z.infer<
  typeof specAssumptionElementViewSchema
>;

// The elements/<handle> endpoint serves R/R.x/D/T revision elements and the
// revision-independent Q/A records through one address space, so every
// bare-handle consumer (CLI, chips, deep links) parses this union.
export const specElementGetResponseSchema = z.union([
  specElementViewSchema,
  specQuestionElementViewSchema,
  specAssumptionElementViewSchema,
]);
export type SpecElementGetResponse = z.infer<
  typeof specElementGetResponseSchema
>;
