import { z } from "zod";

import { executionScopeSchema } from "./scope-validation";
import {
  deliveryDisplaySchema,
  requirementStatusSchema,
  specPhaseProjectionSchema,
  taskWorkStatusSchema,
} from "./phase";
import {
  actorProvenanceSchema,
  evidenceKindSchema,
  resolvedGateDialSchema,
  specAliasSchema,
  specApprovalRowSchema,
  specAssumptionDispositionSchema,
  specAuthoringStageSchema,
  specCommentRowSchema,
  specCriterionDispositionRowSchema,
  specElementKindSchema,
  specEvidenceRowSchema,
  specExecutionStateSchema,
  specWorkflowLaneStatusSchema,
  specGateAdmissionRowSchema,
  specGatePolicySchema,
  specGatePresetSchema,
  specGateSchema,
  specProofVerdictRowSchema,
  specQuestionStatusSchema,
  specRevisionElementSchema,
  specRevisionSchema,
  specRevisionSnapshotSchema,
  specSchema,
  specWaiverRowSchema,
} from "./schemas";

/**
 * A durable snapshot element carrying the handle it is addressed by. The
 * handle is derived, never stored, so it lives here rather than on
 * `specRevisionElementSchema`. It is null for elements with no handle
 * (sections and unnumbered rows), which are addressed by their element id.
 *
 * Optional because payload producers older than this field — fixtures and any
 * caller that has not been migrated — must still satisfy the strict parse.
 * Every read route emits it.
 */
export const specRevisionElementViewSchema = specRevisionElementSchema
  .extend({ handle: z.string().min(1).nullable().optional() })
  .strict();
export type SpecRevisionElementView = z.infer<
  typeof specRevisionElementViewSchema
>;

export const specRevisionSnapshotViewSchema = specRevisionSnapshotSchema
  .extend({ elements: z.array(specRevisionElementViewSchema) })
  .strict();
export type SpecRevisionSnapshotView = z.infer<
  typeof specRevisionSnapshotViewSchema
>;

const specCoverageSchema = z
  .object({
    coveredCriteria: z.number().int().nonnegative(),
    totalCriteria: z.number().int().nonnegative(),
    percentage: z.number().int().min(0).max(100),
  })
  .strict();

/**
 * Historical provenance only. `state` is computed against the current
 * revision (or the selected run); these rows say where the gate was admitted
 * before that, and deliberately carry no claim that the admission still
 * covers today's content. Renderers must not fold them into `state`.
 */
const specGatePriorAdmissionSchema = z
  .object({
    revisionId: z.string().min(1),
    revisionNumber: z.number().int().positive(),
    executionId: z.string().min(1).nullable(),
    basis: specGateAdmissionRowSchema.shape.basis,
    actor: actorProvenanceSchema.nullable(),
    admittedAt: z.string().min(1),
  })
  .strict();
export type SpecGatePriorAdmission = z.infer<
  typeof specGatePriorAdmissionSchema
>;

const specGateStatusSchema = z
  .object({
    gate: specGateSchema,
    dial: resolvedGateDialSchema,
    state: z.enum(["pending", "admitted", "not_required"]),
    priorAdmissions: z.array(specGatePriorAdmissionSchema).default([]),
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

/**
 * The runs behind the phase, reconciled at read time. `phase: executing`
 * collapses every run into one word, so state and workflow linkage are what
 * let a reader tell a parked definition review from a launched lane — and
 * they are the only fields that make a parked run diagnosable without a
 * second full detail read.
 */
const specStatusExecutionSchema = z
  .object({
    id: z.string().min(1),
    state: specExecutionStateSchema,
    workflowDefinitionId: z.string().min(1),
    workflowExecutionId: z.string().min(1).nullable(),
    /**
     * The linked lane's live status at read time. A `running` spec execution
     * whose lane already completed is waiting on the session's delivering
     * merge, not working — this is the only field that shows the difference.
     */
    workflowStatus: specWorkflowLaneStatusSchema.nullable(),
  })
  .strict();
export type SpecStatusExecution = z.infer<typeof specStatusExecutionSchema>;

/**
 * One remaining authoring stage and the gate that concludes it (R25.5).
 * `concludedBy` is `advance` only where the stage's dial admits the transition
 * without review — every other stage ends this draft with a propose, so the
 * next stage is authored in the draft an amendment opens.
 */
const remainingAuthoringStageSchema = z
  .object({
    stage: specAuthoringStageSchema,
    gate: specGateSchema,
    dial: resolvedGateDialSchema,
    concludedBy: z.enum(["advance", "propose"]),
    requiresHumanSignOff: z.boolean(),
  })
  .strict();
export type RemainingAuthoringStage = z.infer<
  typeof remainingAuthoringStageSchema
>;

/**
 * What an open draft still owes under the policy in force (R25.5). A policy
 * change pins `pinnedStage`, so this is the only surface that explains why a
 * draft opened under one preset keeps walking the stage sequence of another.
 * `nextTransition.consultedGates` is the stage-scoped resolution of R10.11 —
 * the draft's stage plus every earlier stage it modified — so it can name
 * gates that no longer appear in `stages`.
 */
export const remainingAuthoringSequenceSchema = z
  .object({
    revisionId: z.string().min(1),
    revisionNumber: z.number().int().positive(),
    pinnedStage: specAuthoringStageSchema,
    stages: z.array(remainingAuthoringStageSchema),
    nextTransition: z
      .object({
        stage: specAuthoringStageSchema,
        action: z.enum(["advance", "propose"]),
        requiresHumanSignOff: z.boolean(),
        consultedGates: z.array(
          z
            .object({ gate: specGateSchema, dial: resolvedGateDialSchema })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
export type RemainingAuthoringSequence = z.infer<
  typeof remainingAuthoringSequenceSchema
>;

/**
 * The change-policy response (R25.5): the resulting spec plus what the open
 * draft still owes under the newly confirmed dials, null when none is open.
 */
export const specPolicyChangeResultSchema = z
  .object({
    spec: specSchema,
    authoringSequence: remainingAuthoringSequenceSchema.nullable(),
  })
  .strict();
export type SpecPolicyChangeResult = z.infer<
  typeof specPolicyChangeResultSchema
>;

/**
 * One project-wide search hit (R24.11). Identity, phase, and preset ride every
 * hit so the competing-spec check an agent is told to run can be answered from
 * one read: whether a spec already covers this ground, and under which policy.
 * `matchedName` is separate from `matches` because a spec whose slug or name
 * matches is a hit even before it has requirement or decision content.
 */
const specSearchHitSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    phase: specPhaseProjectionSchema,
    preset: specGatePresetSchema,
    gatePolicy: specGatePolicySchema,
    matchedName: z.boolean(),
    matchCount: z.number().int().nonnegative(),
    matches: z.array(
      z
        .object({
          handle: z.string().min(1),
          kind: specElementKindSchema,
          elementId: z.string().min(1),
          text: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type SpecSearchHit = z.infer<typeof specSearchHitSchema>;

export const specProjectSearchViewSchema = z
  .object({
    query: z.string(),
    results: z.array(specSearchHitSchema),
  })
  .strict();
export type SpecProjectSearchView = z.infer<typeof specProjectSearchViewSchema>;

/**
 * The server-computed proof standing of one scoped criterion for one run
 * (F26). Computed where the truth lives — the detail route mirrors the
 * delivery gate's precedence and validity rules (waiver validity, the
 * prior-run rule for external delivery, evidence-resolvable verdict
 * freshness) — so Studio renders it verbatim instead of re-deriving a
 * divergent client answer.
 */
export const criterionDeliveryProjectionSchema = z
  .object({
    criterionElementId: z.string().min(1),
    handle: z.string().min(1),
    strategyKinds: z.array(evidenceKindSchema),
    proofState: z.enum([
      "proven_merged",
      "waived",
      "delivered_elsewhere",
      "proof_recorded",
      "awaiting_proof",
    ]),
  })
  .strict();
export type CriterionDeliveryProjection = z.infer<
  typeof criterionDeliveryProjectionSchema
>;

/**
 * A run in the domain shape the rest of this surface speaks: camelCase, the
 * scope column parsed into the object it holds, and the revision's number
 * alongside its internal id.
 *
 * `state`, `workflowDefinitionId` and `workflowExecutionId` are load-bearing,
 * not decoration: they are what separates a run parked awaiting human
 * definition approval from a launched lane, and were once the only way to
 * diagnose a parked execution at all.
 */
export const specExecutionViewSchema = z
  .object({
    id: z.string().min(1),
    specId: z.string().min(1),
    revisionId: z.string().min(1),
    revisionNumber: z.number().int().positive().nullable(),
    state: specExecutionStateSchema,
    workflowDefinitionId: z.string().min(1),
    /**
     * The immutable workflow definition revision compiled for this execution.
     * Null identifies a legacy row that cannot be launched safely by revision.
     */
    workflowDefinitionRevision: z.number().int().positive().nullable(),
    workflowExecutionId: z.string().min(1).nullable(),
    /**
     * The approval contract frozen on the immutable spec execution row. Null
     * identifies a legacy row whose launch contract predates that field.
     */
    definitionApprovalRequired: z.boolean().nullable(),
    /**
     * Null when the stored scope does not parse. A row written by an older
     * build must not 500 the read, and an empty scope would be a different
     * claim than "the scope could not be read".
     */
    scope: executionScopeSchema.nullable(),
    sessionName: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    abandonedReason: z.string().nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    // Required, deliberately no default: a fixture or producer that omits the
    // projection must fail the schema guard loudly rather than render an
    // empty merge gate that silently agrees with a stale server.
    deliveryProjection: z.array(criterionDeliveryProjectionSchema),
  })
  .strict();
export type SpecExecutionView = z.infer<typeof specExecutionViewSchema>;

/**
 * The `start-execution` receipt: the freshly created run in the same domain
 * shape the read path projects, minus the delivery projection (a merge-gate
 * concern the just-started run has no standing for yet). Returning the raw
 * persistence row here is what made `spec start` the one mutation whose
 * response an agent had to read with snake_case keys.
 */
export const specStartedExecutionViewSchema = specExecutionViewSchema.omit({
  deliveryProjection: true,
});
export type SpecStartedExecutionView = z.infer<
  typeof specStartedExecutionViewSchema
>;

/**
 * A gate admission in the domain shape: camelCase, actor provenance parsed
 * into the object it holds, and the revision's number alongside its id. It
 * stays strictly historical — nothing here asserts the gate is satisfied now.
 */
export const specGateAdmissionViewSchema = z
  .object({
    id: z.string().min(1),
    specId: z.string().min(1),
    gate: specGateSchema,
    basis: specGateAdmissionRowSchema.shape.basis,
    approvalId: z.string().min(1).nullable(),
    revisionId: z.string().min(1).nullable(),
    revisionNumber: z.number().int().positive().nullable(),
    executionId: z.string().min(1).nullable(),
    actor: actorProvenanceSchema.nullable(),
    createdAt: z.string().min(1),
  })
  .strict();
export type SpecGateAdmissionView = z.infer<typeof specGateAdmissionViewSchema>;

/**
 * Everything a single-element write needs to address itself, and nothing else.
 * A write must name the revision it targets and, for an update, the element
 * version it is replacing; reading those from the full spec detail made an
 * authoring session transfer the whole document once per element. This is that
 * read, sized to the write (R7.1, R6.2).
 */
export const specEditContextViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    gatePolicy: specGatePolicySchema,
    currentRevision: z
      .object({
        id: z.string().min(1),
        number: z.number().int().positive(),
        state: specRevisionSchema.shape.state,
        authoringStage: specAuthoringStageSchema,
      })
      .strict()
      .nullable(),
    /** What an execution pins; approved revisions are immutable. */
    latestApprovedRevision: z
      .object({
        id: z.string().min(1),
        number: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    /**
     * Present only when the read named an element. Null both for "no element
     * was asked for" and for "the current revision does not carry it" — the
     * second is how a writer learns its next write is a create, not an update.
     */
    element: z
      .object({
        elementId: z.string().min(1),
        handle: z.string().min(1).nullable(),
        kind: specElementKindSchema,
        elementVersion: z.number().int().positive(),
        position: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type SpecEditContextView = z.infer<typeof specEditContextViewSchema>;

export const specStatusViewSchema = z
  .object({
    specId: z.string().min(1),
    slug: z.string().min(1),
    phase: specPhaseProjectionSchema,
    executions: z.array(specStatusExecutionSchema).default([]),
    gates: z.array(specGateStatusSchema),
    // Null exactly when no draft is open; defaulted so payloads written before
    // this field still satisfy the strict parse.
    authoringSequence: remainingAuthoringSequenceSchema
      .nullable()
      .default(null),
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
    baseRevision: specRevisionSnapshotViewSchema.nullable(),
    currentRevision: specRevisionSnapshotViewSchema.nullable(),
    currentApprovedRevision: specRevisionSnapshotViewSchema.nullable(),
    executionRevisionSnapshots: z.array(specRevisionSnapshotViewSchema),
    approvals: z.array(specApprovalRowSchema),
    comments: z.array(specCommentRowSchema),
    executions: z.array(specExecutionViewSchema),
    criterionDispositions: z.array(specCriterionDispositionRowSchema),
    waivers: z.array(specWaiverRowSchema),
    // Admissions recorded against the executions' revisions, so the UI can
    // present gated actions honestly (granted vs still blocking).
    gateAdmissions: z.array(specGateAdmissionViewSchema).default([]),
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
