import { z } from "zod";

import {
  deliveryDisplaySchema,
  requirementStatusSchema,
  specPhaseProjectionSchema,
  taskWorkStatusSchema,
} from "./phase";
import {
  actorProvenanceSchema,
  specAliasSchema,
  specApprovalRowSchema,
  specAssumptionDispositionSchema,
  specCommentRowSchema,
  specCriterionDispositionRowSchema,
  specEvidenceRowSchema,
  specExecutionRowSchema,
  specGateAdmissionRowSchema,
  specGateSchema,
  specProofVerdictRowSchema,
  specQuestionStatusSchema,
  specRevisionElementSchema,
  specRevisionSchema,
  specRevisionSnapshotSchema,
  specSchema,
  specWaiverRowSchema,
} from "./schemas";

const specCoverageSchema = z
  .object({
    coveredCriteria: z.number().int().nonnegative(),
    totalCriteria: z.number().int().nonnegative(),
    percentage: z.number().int().min(0).max(100),
  })
  .strict();

const specGateStatusSchema = z
  .object({
    gate: specGateSchema,
    dial: z.enum(["gate", "notify", "off", "combined-approval"]),
    state: z.enum(["pending", "admitted", "not_required"]),
  })
  .strict();

const pendingApprovalSchema = z
  .object({
    gate: specGateSchema,
    subject: z.string(),
    elementId: z.string().nullable(),
  })
  .strict();

const openQuestionSchema = z
  .object({
    id: z.string().min(1),
    handle: z.string().min(1),
    text: z.string(),
    elementId: z.string().nullable(),
  })
  .strict();

const statusAssumptionSchema = z
  .object({
    id: z.string().min(1),
    handle: z.string().min(1),
    text: z.string(),
    disposition: specAssumptionDispositionSchema,
    elementId: z.string().nullable(),
  })
  .strict();

const specTaskPlanStatusSchema = z
  .object({
    elementId: z.string().min(1),
    handle: z.string().min(1),
    title: z.string().min(1),
    dependsOn: z.array(z.string().min(1)),
    laneGroup: z.string().min(1).nullable(),
    touchedPaths: z.array(z.string().min(1)),
    criterionCoverage: z.array(z.string().min(1)),
  })
  .strict();

export const specStatusViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    phase: specPhaseProjectionSchema,
    gates: z.array(specGateStatusSchema),
    pendingApprovals: z.array(pendingApprovalSchema),
    openQuestions: z.array(openQuestionSchema),
    assumptions: z.array(statusAssumptionSchema).default([]),
    taskPlan: z.array(specTaskPlanStatusSchema).default([]),
    coverage: specCoverageSchema,
    delivery: deliveryDisplaySchema,
  })
  .strict();
export type SpecStatusView = z.infer<typeof specStatusViewSchema>;

export const specQuestionViewSchema = z
  .object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    handle: z.string().min(1),
    elementId: z.string().nullable(),
    text: z.string(),
    status: specQuestionStatusSchema,
    answer: z.string().nullable(),
    answeredAt: z.string().nullable(),
    provenance: actorProvenanceSchema.nullable(),
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
    disposition: specAssumptionDispositionSchema,
    disposedAt: z.string().nullable(),
    proposedBy: actorProvenanceSchema.nullable(),
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

const linkedTicketReadThroughSchema = z
  .object({
    projectName: z.string().min(1),
    number: z.number().int().positive(),
    title: z.string().min(1),
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
  })
  .strict();
export type SpecSummaryView = z.infer<typeof specSummaryViewSchema>;

export const specDetailViewSchema = z
  .object({
    spec: specSchema,
    aliases: z.array(specAliasSchema),
    revisions: z.array(specRevisionSchema),
    baseRevision: specRevisionSnapshotSchema.nullable(),
    currentRevision: specRevisionSnapshotSchema.nullable(),
    currentApprovedRevision: specRevisionSnapshotSchema.nullable(),
    executionRevisionSnapshots: z.array(specRevisionSnapshotSchema),
    approvals: z.array(specApprovalRowSchema),
    comments: z.array(specCommentRowSchema),
    executions: z.array(specExecutionRowSchema),
    criterionDispositions: z.array(specCriterionDispositionRowSchema),
    waivers: z.array(specWaiverRowSchema),
    // Admissions recorded against the executions' revisions, so the UI can
    // present gated actions honestly (granted vs still blocking).
    gateAdmissions: z.array(specGateAdmissionRowSchema).default([]),
    elementStatuses: z
      .object({
        requirements: z.array(
          z
            .object({
              elementId: z.string().min(1),
              status: requirementStatusSchema,
            })
            .strict(),
        ),
        tasks: z.array(
          z
            .object({
              elementId: z.string().min(1),
              status: taskWorkStatusSchema,
            })
            .strict(),
        ),
      })
      .strict(),
    status: specStatusViewSchema,
    linkedTickets: z.array(linkedTicketReadThroughSchema),
    questions: z.array(specQuestionViewSchema).default([]),
    assumptions: z.array(specAssumptionViewSchema).default([]),
  })
  .strict();
export type SpecDetailView = z.infer<typeof specDetailViewSchema>;

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

export const lintFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    severity: z.enum([
      "blocks_propose",
      "blocks_claim",
      "blocks_signoff",
      "advisory",
    ]),
    elementHandle: z.string(),
    message: z.string(),
  })
  .strict();

export const specLintViewSchema = z
  .object({
    revisionId: z.string().min(1),
    findings: z.array(lintFindingSchema),
  })
  .strict();

const specSearchResultSchema = z
  .object({
    handle: z.string().min(1),
    kind: z.enum(["section", "requirement", "criterion", "decision", "task"]),
    elementId: z.string().min(1),
    text: z.string(),
  })
  .strict();

export const specSearchViewSchema = z
  .object({ query: z.string(), results: z.array(specSearchResultSchema) })
  .strict();
export type SpecSearchView = z.infer<typeof specSearchViewSchema>;

export const specInventoryViewSchema = z
  .object({ specs: z.array(specSummaryViewSchema) })
  .strict();
export type SpecInventoryView = z.infer<typeof specInventoryViewSchema>;

const canonicalMarkdownFileSchema = z
  .object({ path: z.string().min(1), content: z.string() })
  .strict();

export const canonicalSpecBundleSchema = z
  .object({
    markdownFiles: z.array(canonicalMarkdownFileSchema),
    manifest: z.string(),
  })
  .strict();
export type CanonicalSpecBundle = z.infer<typeof canonicalSpecBundleSchema>;

const integrityMismatchSchema = z
  .object({
    revisionId: z.string().min(1),
    expectedContentHash: z.string(),
    actualContentHash: z.string(),
    mismatchedElementIds: z.array(z.string().min(1)),
  })
  .strict();

export const integrityReportSchema = z
  .object({
    ok: z.boolean(),
    checkedRevisionIds: z.array(z.string().min(1)),
    mismatches: z.array(integrityMismatchSchema),
  })
  .strict();
export type IntegrityReport = z.infer<typeof integrityReportSchema>;
