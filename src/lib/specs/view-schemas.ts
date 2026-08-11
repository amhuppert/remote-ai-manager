import { z } from "zod";

import { graphWorkflowStatusSchema } from "@/lib/workflow-graph/definition-schemas";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import { revisionDiffResultSchema } from "./revision-diff";
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
  specExecutionCleanupPhaseSchema,
  specExecutionStateSchema,
  specWorkflowLaneStatusSchema,
  specGateAdmissionRowSchema,
  specGatePolicySchema,
  specGatePresetSchema,
  specGateSchema,
  specImportedCountsSchema,
  specProofVerdictRowSchema,
  specQuestionStatusSchema,
  specRevisionElementSchema,
  specRevisionSchema,
  specRevisionSnapshotSchema,
  specRevisionStateSchema,
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
 * One admission row as the projection reports it. Whether it satisfies
 * anything is said by the list it appears in — `currentAdmissions` or
 * `priorAdmissions` — and never by the record itself. Renderers must not fold
 * a prior admission into `state`.
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

/**
 * Why the gate does or does not ask something of the current revision, read
 * against the nearest APPROVED ancestor rather than the immediate parent. A
 * change that entered through a withdrawn attempt is unchanged against that
 * attempt and still unadmitted against the governance baseline.
 */
const specGateApplicabilitySchema = z
  .object({
    reason: z.enum([
      "current_stage",
      "changed_since_governance_base",
      "unchanged_since_governance_base",
      "dial_off",
    ]),
    governanceBaseRevisionId: z.string().min(1).nullable(),
  })
  .strict();

const specGateStatusSchema = z
  .object({
    gate: specGateSchema,
    dial: resolvedGateDialSchema,
    state: z.enum(["pending", "admitted", "not_required"]),
    applicability: specGateApplicabilitySchema,
    /** Admissions the gate holds for the revision or run being read. */
    currentAdmissions: z.array(specGatePriorAdmissionSchema).default([]),
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

/**
 * The revision's own sign-off standing, reported beside the subject approvals
 * rather than folded into them. A consulted human gate stays pending after its
 * last subject approval until a human signs the revision off, so "no pending
 * approvals" and "nothing outstanding" are different answers.
 */
export const revisionSignOffSchema = z
  .object({
    revisionId: z.string().min(1),
    revisionNumber: z.number().int().positive(),
    state: z.enum(["blocked", "ready", "signed_off"]),
    outstandingSubjectCount: z.number().int().nonnegative(),
    unmetConditions: z.array(z.string()),
    approval: specApprovalRowSchema.nullable(),
  })
  .strict();

/**
 * A subject an import admission settles rather than a human approval. Carried
 * on the wire beside the outstanding subjects because absence from those is
 * how a surface concludes "approved", and no human approved these.
 */
const importCarriedApprovalSchema = z
  .object({
    gate: specGateSchema,
    subject: z.string(),
    elementId: z.string().min(1),
  })
  .strict();

const pendingGateBlockSchema = z
  .object({
    gate: specGateSchema,
    dial: resolvedGateDialSchema,
    state: z.enum(["pending", "admitted", "not_required"]),
    applicability: specGateApplicabilitySchema,
    subjects: z.array(z.string()),
    // Defaulted so a payload written before this field still satisfies the
    // strict parse; a spec no import created carries none.
    importCarriedSubjects: z.array(z.string()).default([]),
  })
  .strict();

/**
 * Everything a transition response says about what still blocks the revision,
 * authored on the server. A caller renders it; deriving a blocker from the
 * revision's authoring stage names the wrong gate whenever an earlier stage is
 * also consulted, and cannot name the subject a request needs.
 */
export const authoringPendingBlockSchema = z
  .object({
    actsNext: z.enum(["human", "agent"]),
    gates: z.array(pendingGateBlockSchema),
    outstandingSubjects: z.array(pendingApprovalSchema),
    signOff: revisionSignOffSchema.nullable(),
    unmetConditions: z.array(z.string()),
    display: z.string(),
    instruction: z.string(),
  })
  .strict();
export type AuthoringPendingBlockView = z.infer<
  typeof authoringPendingBlockSchema
>;

export const authoringNextActionSchema = z
  .object({
    kind: z.enum([
      "approve_subject",
      "sign_off_revision",
      "resolve_conditions",
      "propose",
      "amend",
      "none",
    ]),
    actsNext: z.enum(["human", "agent"]).nullable(),
    gate: specGateSchema.nullable(),
    subject: z.string().nullable(),
    elementId: z.string().nullable(),
    instruction: z.string(),
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
    /** Handles of the depended-on tasks this revision carries, in payload order. */
    dependsOn: z.array(z.string().min(1)),
    /**
     * Depended-on task ids this revision does not carry, sorted. Rendering one
     * raw in `dependsOn` would put an id the compiler cannot order in a field
     * of handles, hiding the same fork the unresolved criteria expose.
     * Defaulted so a payload from a server without the field still parses.
     */
    unresolvedDependsOnTaskElementIds: z.array(z.string().min(1)).default([]),
    laneGroup: z.string().min(1).nullable(),
    /**
     * The lane the compiler will place this task's context on, or null when it
     * compiles to a single-member lane. Defaulted so a payload from a server
     * without the field still satisfies the strict parse.
     */
    executionLane: z.string().min(1).nullable().default(null),
    touchedPaths: z.array(z.string().min(1)),
    /** Handles of the covered criteria this revision carries, in payload order. */
    criterionCoverage: z.array(z.string().min(1)),
    /**
     * Covered criterion ids this revision does not carry, sorted. They are
     * counted by neither side of `coverage`, so a reader who is not told about
     * them reads a plan pointing at lost content as fully covered. Defaulted so
     * a payload from a server without the field still satisfies the strict parse.
     */
    unresolvedCriterionElementIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

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

/**
 * The status-sized reading of the draft's lint: how much there is, how much of
 * it refuses propose, and the first few findings by severity. It is the same
 * `draftHealth` projection the lint verb prints in full, cut to a tier — so a
 * status that says zero blocking and a propose that refuses cannot coexist.
 */
const draftHealthTierSchema = z
  .object({
    revisionId: z.string().min(1),
    total: z.number().int().nonnegative(),
    blocking: z.number().int().nonnegative(),
    counts: z.array(
      z
        .object({
          severity: lintFindingSchema.shape.severity,
          count: z.number().int().positive(),
        })
        .strict(),
    ),
    top: z.array(lintFindingSchema),
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
        /**
         * The gates a propose consults, measured against the nearest approved
         * ancestor and independent of the dials. A caller previewing other
         * dials reads them here rather than re-deriving them from the
         * immediate parent, which drops obligations a withdrawn attempt left.
         */
        governanceConsultedGates: z.array(specAuthoringStageSchema),
      })
      .strict(),
  })
  .strict();
export type RemainingAuthoringSequence = z.infer<
  typeof remainingAuthoringSequenceSchema
>;

/**
 * The propose receipt. `pendingBlock` and `nextAction` are the server's
 * post-transition projection — computed after approval invalidation and after
 * the Notify/Off policy admissions — so a caller renders what still blocks the
 * revision instead of inferring a gate from its authoring stage.
 */
export const specProposeResultViewSchema = z
  .object({
    revision: specRevisionSchema,
    diff: revisionDiffResultSchema,
    absorbedSignOff: z.boolean(),
    pendingBlock: authoringPendingBlockSchema.nullable().default(null),
    nextAction: authoringNextActionSchema.nullable().default(null),
  })
  .strict();
export type SpecProposeResultView = z.infer<typeof specProposeResultViewSchema>;

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
    /**
     * Consulted subjects an import admission settles — never approvals. A
     * surface that reports "all approved" from an empty `pendingApprovals`
     * must subtract these first.
     */
    importCarriedApprovals: z.array(importCarriedApprovalSchema).default([]),
    /** The gates this revision's transition consults, in gate order. */
    applicableGates: z.array(specGateSchema).default([]),
    revisionSignOff: revisionSignOffSchema.nullable().default(null),
    pendingBlock: authoringPendingBlockSchema.nullable().default(null),
    nextAction: authoringNextActionSchema.nullable().default(null),
    openQuestions: z.array(openQuestionSchema),
    assumptions: z.array(statusAssumptionSchema).default([]),
    taskPlan: z.array(specTaskPlanStatusSchema).default([]),
    // Null exactly when the spec carries no revision to lint. Defaulted so a
    // payload written before this field still satisfies the strict parse.
    draftHealth: draftHealthTierSchema.nullable().default(null),
    coverage: specCoverageSchema,
    delivery: deliveryDisplaySchema,
    /**
     * Whether this spec entered the system by import, derived server-side from
     * the `import`-basis gate admissions on the current approved revision's
     * lineage. It stores nothing new: it is the one bit the surfaces that never
     * load admissions — the inventory row, the review header — need in order to
     * attribute imported content to import rather than to a human. Required
     * rather than defaulted: a default is fail-open in the one direction that
     * matters, parsing a truncated payload as natively authored.
     */
    imported: z.boolean(),
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
    /** The status view's import provenance, carried so an inventory row can
     * mark an imported spec without loading the whole detail. Required for the
     * same reason the status field is. */
    imported: z.boolean(),
  })
  .strict();
export type SpecSummaryView = z.infer<typeof specSummaryViewSchema>;

/**
 * One revision currently under review, with the verdict the shared
 * supersession predicate reached about it and the snapshots its diff needs.
 *
 * The snapshots ride the entry rather than being looked up by id against the
 * detail's other snapshot fields: a stranded proposal is by definition not the
 * lineage head, so no existing field carries it, and a surface that had to
 * assemble the pair itself is exactly the second projection ticket #50's dead
 * end came from.
 */
export const liveProposalViewSchema = z
  .object({
    revision: specRevisionSchema,
    /** The approved revision that forked past it; null while it is current. */
    supersededBy: specRevisionSchema.nullable(),
    snapshot: specRevisionSnapshotViewSchema,
    /** Its lineage parent — the content its diff is read against. */
    baseSnapshot: specRevisionSnapshotViewSchema.nullable(),
    /**
     * The author's disposition document, read-only, as it was recorded on this
     * proposal's own propose event. It rides the projection entry so a
     * stranded proposal's notes are as reachable as the current one's — the
     * asymmetry is what #50's dead end was made of. Defaulted so a client
     * newer than its server still parses the entry.
     */
    notes: z.string().nullable().default(null),
  })
  .strict();
export type LiveProposalView = z.infer<typeof liveProposalViewSchema>;

/**
 * What the durable `spec_imported` event knows and nothing else: the source
 * label and the content counts exist nowhere but that event. Which revision the
 * import created is deliberately absent — the basis-`import` gate admissions
 * already state it, and a second copy on the wire is a provenance source that
 * can drift from the one the gates are actually keyed to. Consumers that need
 * the imported revision read the admissions.
 */
export const specImportRecordViewSchema = z
  .object({
    occurredAt: z.string().min(1),
    /** The external document the bundle named, verbatim. */
    sourceLabel: z.string().min(1),
    counts: specImportedCountsSchema,
  })
  .strict();
export type SpecImportRecordView = z.infer<typeof specImportRecordViewSchema>;

export const specDetailViewSchema = z
  .object({
    spec: specSchema,
    aliases: z.array(specAliasSchema),
    revisions: z.array(specRevisionSchema),
    /**
     * Every proposed revision, oldest first — not just the lineage head. The
     * Review tab, the attention badge, the lifecycle strip, the Overview
     * action, and History all read this one list, so a proposal cannot be
     * actionable on one surface and invisible on another (#50).
     */
    liveProposals: z.array(liveProposalViewSchema).default([]),
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
    /**
     * Null for every spec authored here, and null for an imported spec whose
     * event payload is unreadable — this carries the import's *detail*, not the
     * fact of it. The fact lives in `gateAdmissions`, so a null here narrows
     * what History can say without ever letting an imported revision read as a
     * human sign-off.
     */
    importRecord: specImportRecordViewSchema.nullable(),
  })
  .strict();
export type SpecDetailView = z.infer<typeof specDetailViewSchema>;

/**
 * Which revision the comparison is measured from. `review` is the immediate
 * parent (`basedOnRevisionId`) — the pair Spec Studio's review cards diff, and
 * therefore the pair a reviewer signs off on. `governance` is the nearest
 * approved ancestor, which is what gate applicability is measured against and
 * can differ whenever an attempt was withdrawn or is still under review.
 * `explicit` means the caller named the base itself.
 */
export const specDiffBaselineSchema = z.enum([
  "review",
  "governance",
  "explicit",
]);
export type SpecDiffBaseline = z.infer<typeof specDiffBaselineSchema>;

const specDiffRevisionRefSchema = z
  .object({
    revisionId: z.string().min(1),
    number: z.number().int().positive(),
    state: specRevisionStateSchema,
  })
  .strict();

/**
 * One element's class in the comparison. The diff engine reports "added" only
 * on its change list and "unchanged" only on its classifications; this joins
 * both into the single four-value class every reader (CLI, Studio card) shows,
 * so neither surface has to re-derive it. `summary` is null exactly when the
 * element is unchanged, and `directlyChanged` is false for a requirement that
 * moved only because one of its criteria did.
 */
const specDiffElementSchema = z
  .object({
    elementId: z.string().min(1),
    handle: z.string().min(1).nullable(),
    kind: specElementKindSchema,
    classification: z.enum(["added", "modified", "removed", "unchanged"]),
    directlyChanged: z.boolean(),
    summary: z.string().min(1).nullable(),
  })
  .strict();

export const specDiffViewSchema = z
  .object({
    slug: z.string().min(1),
    baseline: specDiffBaselineSchema,
    /** Null when the compared revision is the root of its lineage. */
    from: specDiffRevisionRefSchema.nullable(),
    to: specDiffRevisionRefSchema,
    elements: z.array(specDiffElementSchema),
    planStale: z.boolean(),
  })
  .strict();
export type SpecDiffView = z.infer<typeof specDiffViewSchema>;

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

/**
 * The one consistency-finding shape `cctl spec verify` reports (design §9).
 *
 * Content hashes answer "was this spec's approved text tampered with"; they
 * cannot answer "did an act this spec started ever finish". Both unfinished-act
 * classes — a cleanup the abandon coordinator never completed, and a proposal
 * an approval forked past — land in this ONE discriminated union so a reader,
 * the CLI renderer, and Studio consume a single report rather than a second
 * parallel section per family.
 *
 * Every member carries `remedy`: the exact act that disposes of the finding,
 * with its target id, so a report never states a problem without its exit.
 */
const executionLifecycleFindingSchema = z
  .object({
    family: z.literal("execution-lifecycle"),
    code: z.enum([
      /** A durable `abandoning` row: the coordinator stopped mid-cleanup. */
      "abandon_cleanup_unfinished",
      /**
       * `abandoned`, yet the linked run is still live or still owns the
       * session's slot — the pre-coordinator orphan shape. No coordinator
       * re-entry exists from `abandoned`, so its remedy is workflow-side.
       */
      "abandoned_execution_workflow_unreleased",
    ]),
    specExecutionId: z.string().min(1),
    /** The coordinator's reached phase; null outside `abandoning`. */
    cleanupPhase: specExecutionCleanupPhaseSchema.nullable(),
    workflowExecutionId: z.string().min(1).nullable(),
    workflowStatus: graphWorkflowStatusSchema.nullable(),
    /** Whether the linked run still holds the session's execution slot. */
    ownsExecutionSlot: z.boolean(),
    detail: z.string().min(1),
    remedy: z.string().min(1),
  })
  .strict();

const proposalIntegrityFindingSchema = z
  .object({
    family: z.literal("proposal-integrity"),
    code: z.enum([
      /** An approved revision forked past this live proposal (#50). */
      "superseded_proposal",
      /** Live alongside another proposal, but nothing forked past it. */
      "competing_live_proposal",
    ]),
    revisionId: z.string().min(1),
    revisionNumber: z.number().int().positive(),
    /** Non-null exactly for `superseded_proposal`. */
    supersededByRevisionId: z.string().min(1).nullable(),
    detail: z.string().min(1),
    remedy: z.string().min(1),
  })
  .strict();

export const specConsistencyFindingSchema = z.discriminatedUnion("family", [
  executionLifecycleFindingSchema,
  proposalIntegrityFindingSchema,
]);
export type SpecConsistencyFinding = z.infer<
  typeof specConsistencyFindingSchema
>;

export const integrityReportSchema = z
  .object({
    ok: z.boolean(),
    checkedRevisionIds: z.array(z.string().min(1)),
    mismatches: z.array(integrityMismatchSchema),
    consistencyFindings: z.array(specConsistencyFindingSchema),
  })
  .strict();
export type IntegrityReport = z.infer<typeof integrityReportSchema>;

const evidenceProducerRowSchema = z
  .object({
    kind: z.string().min(1),
    /** Null names a gap: nothing in the ingest path mints this kind. */
    producer: z.string().min(1).nullable(),
    detail: z.string().min(1),
  })
  .strict();

const specPlanPreviewCriterionBriefSchema = z
  .object({
    criterionElementId: z.string().min(1),
    criterionHandle: z.string().min(1),
    text: z.string(),
    brief: z.string(),
    strategyNote: z.string().nullable(),
    evidence: z.array(evidenceProducerRowSchema),
  })
  .strict();

const specPlanPreviewContextSchema = z
  .object({
    contextId: z.string().min(1),
    title: z.string(),
    description: z.string().nullable(),
    acceptanceCriteria: z.string(),
    taskHandles: z.array(z.string().min(1)),
    criterionBriefs: z.array(specPlanPreviewCriterionBriefSchema),
    totalBriefCount: z.number().int().nonnegative(),
    shownBriefCount: z.number().int().nonnegative(),
    omittedBriefCount: z.number().int().nonnegative(),
  })
  .strict();

const specPlanPreviewEdgeSchema = z
  .object({
    id: z.string().min(1),
    sourceContextId: z.string().min(1),
    targetContextId: z.string().min(1),
  })
  .strict();

/**
 * The bounded plan preview the CLI and Studio read. The unbounded projection
 * (including the full compiled definition the parity contract is stated
 * against) stays server-side in `plan-preview.ts`; what crosses the wire is
 * already capped, which is what keeps a wide plan's preview readable.
 */
export const specPlanPreviewViewSchema = z
  .object({
    spec: z
      .object({
        id: z.string().min(1),
        slug: z.string().min(1),
        name: z.string().min(1),
      })
      .strict(),
    revision: z
      .object({
        id: z.string().min(1),
        number: z.number().int().positive(),
        state: specRevisionStateSchema,
        authoringStage: specAuthoringStageSchema,
      })
      .strict(),
    scopeHash: z.string().min(1),
    approvalRequired: z.boolean(),
    charter: workflowCharterSchema,
    totalContextCount: z.number().int().nonnegative(),
    shownContextCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    criterionCount: z.number().int().nonnegative(),
    contexts: z.array(specPlanPreviewContextSchema),
    edges: z.array(specPlanPreviewEdgeSchema),
    evidenceGaps: z.array(z.string().min(1)),
    briefLimit: z.number().int().positive(),
  })
  .strict();
export type SpecPlanPreviewView = z.infer<typeof specPlanPreviewViewSchema>;
