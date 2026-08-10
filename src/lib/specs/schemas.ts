import { z } from "zod";

const idSchema = z.string().min(1);
const timestampSchema = z.string().min(1);
const jsonColumnSchema = z.string();
const nullableIdSchema = idSchema.nullable();
const nullableTimestampSchema = timestampSchema.nullable();
const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);

export const sectionRoleSchema = z.enum([
  "intent_problem",
  "intent_outcomes",
  "intent_non_goals",
  "intent_success_measures",
  "intent_constraints",
  "design_narrative",
  "context",
]);
export type SectionRole = z.infer<typeof sectionRoleSchema>;

export const requirementPrioritySchema = z.enum(["must", "should", "could"]);
export type RequirementPriority = z.infer<typeof requirementPrioritySchema>;

export const requirementRiskSchema = z.enum(["high", "medium", "low"]);
export type RequirementRisk = z.infer<typeof requirementRiskSchema>;

/**
 * Only machine-producible evidence survives in the vocabulary: the server
 * ingests commits and validation results from workflow events, and nothing
 * can produce diff/screenshot/human_signoff evidence (ticket #24). The human
 * lever for an unprovable criterion is a Spec Studio Controls-view waiver.
 */
export const evidenceKindSchema = z.enum([
  "commit",
  "test_run",
  "validator_verdict",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/**
 * The kinds the delivery gate can prove with a machine verdict. `commit` is
 * deliberately excluded: commit evidence can never cite a merge_validation
 * ref, so a strategy of only commits is an obligation nothing can prove.
 */
export const MACHINE_VALIDATION_EVIDENCE_KINDS = [
  "test_run",
  "validator_verdict",
] as const satisfies readonly EvidenceKind[];
export type MachineValidationEvidenceKind =
  (typeof MACHINE_VALIDATION_EVIDENCE_KINDS)[number];
export function isMachineValidationEvidenceKind(
  kind: EvidenceKind,
): kind is MachineValidationEvidenceKind {
  return MACHINE_VALIDATION_EVIDENCE_KINDS.includes(
    kind as MachineValidationEvidenceKind,
  );
}

/**
 * Exported as its own schema instance so the CLI's published JSON Schema can
 * recognize this exact node and attach the machine-kind `contains` constraint
 * that the `.refine()` below enforces but `z.toJSONSchema` cannot express.
 */
export const validationStrategyKindsSchema = z.array(evidenceKindSchema);

export const validationStrategySchema = z
  .object({
    kinds: validationStrategyKindsSchema,
    note: z.string().optional(),
  })
  .strict()
  .refine((strategy) => strategy.kinds.some(isMachineValidationEvidenceKind), {
    message:
      "A validation strategy must include at least one machine-provable evidence kind (test_run or validator_verdict); the delivery gate cannot prove a criterion from commits alone.",
    path: ["kinds"],
  });
export type ValidationStrategy = z.infer<typeof validationStrategySchema>;

export const sectionElementPayloadSchema = z
  .object({
    kind: z.literal("section"),
    role: sectionRoleSchema,
    title: z.string(),
    body: z.string(),
  })
  .strict();
export type SectionElementPayload = z.infer<typeof sectionElementPayloadSchema>;

export const requirementElementPayloadSchema = z
  .object({
    kind: z.literal("requirement"),
    statement: z.string(),
    priority: requirementPrioritySchema,
    risk: requirementRiskSchema,
  })
  .strict();
export type RequirementElementPayload = z.infer<
  typeof requirementElementPayloadSchema
>;

export const criterionElementPayloadSchema = z
  .object({
    kind: z.literal("criterion"),
    text: z.string(),
    validationStrategy: validationStrategySchema,
  })
  .strict();
export type CriterionElementPayload = z.infer<
  typeof criterionElementPayloadSchema
>;

export const rejectedAlternativeSchema = z
  .object({
    label: z.string(),
    reason: z.string(),
  })
  .strict();
export type RejectedAlternative = z.infer<typeof rejectedAlternativeSchema>;

export const decisionElementPayloadSchema = z
  .object({
    kind: z.literal("decision"),
    title: z.string(),
    chosenApproach: z.string(),
    rejectedAlternatives: z.array(rejectedAlternativeSchema),
    reason: z.string(),
    tracedRequirementElementIds: z.array(idSchema),
  })
  .strict();
export type DecisionElementPayload = z.infer<
  typeof decisionElementPayloadSchema
>;

export const touchedPathSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const segments = value.split("/");
    const invalid =
      value !== value.trim() ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value) ||
      value.includes("\\") ||
      value.endsWith("/") ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      );
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        message:
          "touched paths must be normalized repo-relative POSIX paths without parent segments or trailing separators",
      });
    }
  });
export type TouchedPath = z.infer<typeof touchedPathSchema>;

export const taskElementPayloadSchema = z
  .object({
    kind: z.literal("task"),
    title: z.string(),
    instructions: z.string(),
    tracedRequirementElementIds: z.array(idSchema),
    tracedDecisionElementIds: z.array(idSchema),
    coveredCriterionElementIds: z.array(idSchema),
    dependsOnTaskElementIds: z.array(idSchema),
    laneGroup: z.string().min(1).optional(),
    touchedPaths: z.array(touchedPathSchema).optional(),
  })
  .strict();
export type TaskElementPayload = z.infer<typeof taskElementPayloadSchema>;

export const specElementPayloadSchema = z.discriminatedUnion("kind", [
  sectionElementPayloadSchema,
  requirementElementPayloadSchema,
  criterionElementPayloadSchema,
  decisionElementPayloadSchema,
  taskElementPayloadSchema,
]);
export type SpecElementPayload = z.infer<typeof specElementPayloadSchema>;

export const specAuthoringStageSchema = z.enum([
  "requirements",
  "design",
  "plan",
]);
export type SpecAuthoringStage = z.infer<typeof specAuthoringStageSchema>;

export const specGatePresetSchema = z.enum([
  "contract-bearing",
  "exploratory",
  "fast-path",
]);
export type SpecGatePreset = z.infer<typeof specGatePresetSchema>;

export const specGateSchema = z.enum([
  "requirements",
  "design",
  "plan",
  "execution_start",
  "delivery",
]);
export type SpecGate = z.infer<typeof specGateSchema>;

export const specGateDialSchema = z.enum(["gate", "notify", "off"]);
export type SpecGateDial = z.infer<typeof specGateDialSchema>;

/**
 * What an approval request asks for. `gate` asks for the gate as a whole — the
 * ask an omitted subject always makes, at twelve outstanding subjects or none
 * — and is answered by the act that admits the gate. `item` asks for one named
 * subject and is answered by that subject's approval alone.
 *
 * It is part of the durable request identity, so the meaning of a request can
 * never drift as its gate's outstanding set shrinks.
 */
export const specApprovalRequestScopeSchema = z.enum(["gate", "item"]);
export type SpecApprovalRequestScope = z.infer<
  typeof specApprovalRequestScopeSchema
>;

/**
 * The fast-path dial: authorable only as a preset, never as an override, so it
 * is a resolution result rather than a storable dial value.
 */
export const COMBINED_APPROVAL_DIAL = "combined-approval";

export const resolvedGateDialSchema = z.union([
  specGateDialSchema,
  z.literal(COMBINED_APPROVAL_DIAL),
]);
export type ResolvedGateDial = z.infer<typeof resolvedGateDialSchema>;

export const specGatePolicySchema = z
  .object({
    preset: specGatePresetSchema,
    overrides: z.partialRecord(specGateSchema, specGateDialSchema).optional(),
  })
  .strict();
export type SpecGatePolicy = z.infer<typeof specGatePolicySchema>;

export const evidenceEvaluatedStateSchema = z
  .object({
    commitSha: z.string().optional(),
    relevantPaths: z.array(z.string()),
    relevantTreeHash: z.string().optional(),
    surfaceId: z.string().optional(),
  })
  .strict();
export type EvidenceEvaluatedState = z.infer<
  typeof evidenceEvaluatedStateSchema
>;

export const agentActorProvenanceSchema = z
  .object({
    kind: z.literal("agent"),
    conversationId: idSchema,
    backend: z.string().min(1).optional(),
  })
  .strict();
export type AgentActorProvenance = z.infer<typeof agentActorProvenanceSchema>;

export const humanActorProvenanceSchema = z
  .object({
    kind: z.literal("human"),
  })
  .strict();
export type HumanActorProvenance = z.infer<typeof humanActorProvenanceSchema>;

export const actorProvenanceSchema = z.discriminatedUnion("kind", [
  agentActorProvenanceSchema,
  humanActorProvenanceSchema,
]);
export type ActorProvenance = z.infer<typeof actorProvenanceSchema>;

export const refusalCodeSchema = z.enum([
  "gate_blocked",
  "stage_blocked",
  "stale_stage",
  "lint_blocked",
  "stale_element",
  "unresolvable_evidence",
  "invalid_scope",
  "revision_not_approved",
  // An ordinary authoring continuation was asked for while a revision is
  // proposed and under review. Distinct from `revision_not_approved`, which
  // diagnoses an execution pinned to an unapproved revision: that code tells
  // the reader to get the revision approved, this one tells them to conclude
  // the review before opening the next revision.
  "revision_in_review",
  "execution_active",
  "human_act_required",
  "amendment_required",
  "integrity_mismatch",
  "region_locked",
  "delivery_gate_failed",
  "slug_taken",
  "element_id_taken",
  // A write that names an element id THIS spec already owns but whose versions
  // all live outside the target revision. Distinct from `element_id_taken`,
  // which reports an id owned by another spec and can only be resolved by
  // choosing a different one: this identity can come back, so the refusal
  // states the retry that brings it back with its number and handle intact.
  "historical_element_id",
  // A write whose committed result would leave a typed element reference
  // pointing at an element the revision does not carry, or carries under
  // another kind. Distinct from `lint_blocked`, which reports the propose-time
  // sweep over content that is already committed: this one refuses the write
  // itself, so a fork can never be authored against in the first place.
  "dangling_reference",
  // A proposal withdrawal asked for by anyone other than the conversation the
  // durable propose event names as the author — a human, a successor
  // conversation, or a propose whose provenance cannot be read at all. It fails
  // closed: there is no takeover flag, because a conversation that did not
  // write the proposal cannot know what the review is mid-way through.
  "proposal_not_owned",
  // Approval-request refusals (R10.9, R24.1). A request that names a revision
  // the gate is no longer evaluated against, a gate the policy does not gate
  // on or the draft has not reached, a subject with nothing outstanding, or an
  // approval already granted would each open a Needs You entry no human act
  // can clear, so each is refused with its own diagnosis.
  "stale_revision",
  "gate_not_applicable",
  "invalid_subject",
  "already_satisfied",
  // A delivery-plan draft edit whose compare-and-swap token is behind the
  // attempt's current draft revision. Distinct from `stale_element`, which is
  // element-granular within a revision: this one guards the whole plan
  // document, and its remedy is a re-read of the attempt rather than of one
  // element.
  "stale_plan_draft",
  // A delivery-plan act asked for in an attempt status that cannot serve it —
  // editing a proposal, reopening a launched run, opening a second attempt.
  // Every one names the act that IS available from that status.
  "plan_status_conflict",
  // A launch whose spec-side records committed but whose workflow start did
  // not take. Distinct from `integrity_mismatch`: nothing about the approved
  // candidate is wrong, so the remedy is a retry or an abandon of the run that
  // now exists — never a re-approval.
  "workflow_unavailable",
  "not_found",
  "validation",
]);
export type RefusalCode = z.infer<typeof refusalCodeSchema>;

export const refusalSchema = z
  .object({
    code: refusalCodeSchema,
    unmetConditions: z.array(z.string()),
    findings: z.array(z.unknown()).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    instruction: z.string(),
  })
  .strict();
export type Refusal = z.infer<typeof refusalSchema>;

export const specSseEventTypeSchema = z.enum([
  "spec-changed",
  "spec-revision-changed",
  "spec-approval-changed",
  "spec-execution-changed",
  "spec-evidence-changed",
  "spec-attention-changed",
]);
export type SpecSseEventType = z.infer<typeof specSseEventTypeSchema>;

export const specReviewEventTypeSchema = z.enum([
  "spec-review-commented",
  "spec-review-changes-requested",
  "spec-review-item-approved",
  "spec-review-item-unapproved",
  "spec-review-revision-signed-off",
]);
export type SpecReviewEventType = z.infer<typeof specReviewEventTypeSchema>;

/**
 * Durable-only event type for server enforcement interventions (refused
 * transitions). Not part of the SSE union: refusals are already surfaced
 * synchronously to the caller; the row exists so release evidence can count
 * refusals and detect out-of-band repairs (Requirement 21.4).
 */
export const specInterventionEventTypeSchema = z.enum([
  "spec-intervention-recorded",
]);
export type SpecInterventionEventType = z.infer<
  typeof specInterventionEventTypeSchema
>;

/**
 * Durable-only audit trail for `DeliveryPlanAttempt` transitions. Not part of
 * the SSE union: the attempt is a spec-side document with no live subscriber
 * yet, and the rows exist so every status move — including the reopen that
 * invalidates an approval — is reconstructable after the fact.
 */
export const specDeliveryPlanEventTypeSchema = z.enum([
  "spec-delivery-plan-opened",
  "spec-delivery-plan-proposed",
  "spec-delivery-plan-reopened",
  "spec-delivery-plan-transitioned",
  "spec-delivery-plan-commented",
  "spec-delivery-plan-reaffirmed",
]);
export type SpecDeliveryPlanEventType = z.infer<
  typeof specDeliveryPlanEventTypeSchema
>;

export const specEventTypeSchema = z.union([
  specSseEventTypeSchema,
  specReviewEventTypeSchema,
  specInterventionEventTypeSchema,
  specDeliveryPlanEventTypeSchema,
]);
export type SpecEventType = z.infer<typeof specEventTypeSchema>;

export const specElementKindSchema = z.enum([
  "section",
  "requirement",
  "criterion",
  "decision",
  "task",
]);
export type SpecElementKind = z.infer<typeof specElementKindSchema>;

export const specRevisionStateSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "withdrawn",
]);
export type SpecRevisionState = z.infer<typeof specRevisionStateSchema>;

export const specApprovalSubjectKindSchema = z.enum([
  "requirement",
  "decision",
  "revision",
  "plan",
]);
export type SpecApprovalSubjectKind = z.infer<
  typeof specApprovalSubjectKindSchema
>;

export const specApprovalValiditySchema = z.enum(["valid", "stale", "closed"]);
export type SpecApprovalValidity = z.infer<typeof specApprovalValiditySchema>;

export const specGateAdmissionBasisSchema = z.enum([
  "human_approval",
  "notify_policy",
  "off_policy",
]);
export type SpecGateAdmissionBasis = z.infer<
  typeof specGateAdmissionBasisSchema
>;

export const specQuestionStatusSchema = z.enum(["open", "answered"]);
export type SpecQuestionStatus = z.infer<typeof specQuestionStatusSchema>;

export const specAssumptionDispositionSchema = z.enum([
  "proposed",
  "confirmed",
  "rejected",
  "deferred",
]);
export type SpecAssumptionDisposition = z.infer<
  typeof specAssumptionDispositionSchema
>;

export const specCommentResolutionSchema = z.enum([
  "open",
  "resolved",
  "dismissed",
]);
export type SpecCommentResolution = z.infer<typeof specCommentResolutionSchema>;

export const specProofVerdictKindSchema = z.enum([
  "deterministic_validator",
  "agent_validator",
  "human",
]);
export type SpecProofVerdictKind = z.infer<typeof specProofVerdictKindSchema>;

export const specCriterionDispositionSchema = z.enum([
  "in_scope",
  "deferred",
  "waived",
  "delivered_elsewhere",
]);
export type SpecCriterionDisposition = z.infer<
  typeof specCriterionDispositionSchema
>;

export const specTaskClaimStatusSchema = z.enum(["accepted", "reopened"]);
export type SpecTaskClaimStatus = z.infer<typeof specTaskClaimStatusSchema>;

export const specExecutionStateSchema = z.enum([
  "definition_review",
  "running",
  "delivered",
  "abandoned",
  /**
   * Cleanup is in flight (design §10): the abandonment was accepted and its
   * coordinator is working through `cleanup_phase`. A durable, resumable state
   * rather than an in-memory step because a crash between aborting the linked
   * workflow and releasing its slot is exactly the orphan this replaces —
   * `abandoned` is reachable only after the final phase.
   */
  "abandoning",
]);
export type SpecExecutionState = z.infer<typeof specExecutionStateSchema>;

/**
 * The abandon coordinator's ordered cleanup phases (design §10). This exact
 * vocabulary is what downstream orphan verification reads, so no other
 * cleanup-state naming exists anywhere. The transition table lives in
 * `abandon-coordinator.ts`.
 */
export const specExecutionCleanupPhaseSchema = z.enum([
  "abort_workflow",
  "release_slot",
  "finalize",
]);
export type SpecExecutionCleanupPhase = z.infer<
  typeof specExecutionCleanupPhaseSchema
>;

/**
 * The linked graph-workflow execution's live status, as the reconcile read
 * reports it. A spec execution stays `running` between workflow completion
 * and the session's delivering merge, so this is the only field that lets a
 * reader tell "lanes are working" from "everything finished; merge pending"
 * and from "halted awaiting attention".
 */
export const specWorkflowLaneStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "halted",
  "aborted",
]);
export type SpecWorkflowLaneStatus = z.infer<
  typeof specWorkflowLaneStatusSchema
>;

export const specLinkObjectKindSchema = z.enum([
  "ticket",
  "conversation",
  "session",
  "workflow_execution",
  "merge_job",
]);
export type SpecLinkObjectKind = z.infer<typeof specLinkObjectKindSchema>;

export const specLinkCategorySchema = z.enum([
  "graduated_from",
  "materialized_from",
  "reference",
  "source",
]);
export type SpecLinkCategory = z.infer<typeof specLinkCategorySchema>;

export const specRowSchema = z.object({
  id: idSchema,
  project_path: z.string().min(1),
  slug: z.string().min(1),
  name: z.string(),
  gate_policy_json: jsonColumnSchema,
  abandoned_at: nullableTimestampSchema,
  abandoned_reason: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecRow = z.infer<typeof specRowSchema>;

export const specAliasRowSchema = z.object({
  project_path: z.string().min(1),
  slug: z.string().min(1),
  spec_id: idSchema,
  created_at: timestampSchema,
});
export type SpecAliasRow = z.infer<typeof specAliasRowSchema>;

export const specCounterRowSchema = z.object({
  spec_id: idSchema,
  scope_key: z.string().regex(/^(?:R|D|T|Q|A|C:.+)$/),
  last_number: z.number().int().nonnegative(),
});
export type SpecCounterRow = z.infer<typeof specCounterRowSchema>;

export const specElementRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  kind: specElementKindSchema,
  number: z.number().int().positive().nullable(),
  parent_element_id: nullableIdSchema,
  created_at: timestampSchema,
});
export type SpecElementRow = z.infer<typeof specElementRowSchema>;

export const specRevisionRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  number: z.number().int().positive(),
  state: specRevisionStateSchema,
  authoring_stage: specAuthoringStageSchema,
  based_on_revision_id: nullableIdSchema,
  content_hash: z.string().nullable(),
  proposed_at: nullableTimestampSchema,
  approved_at: nullableTimestampSchema,
  created_at: timestampSchema,
});
export type SpecRevisionRow = z.infer<typeof specRevisionRowSchema>;

export const specRevisionSupersessionRowSchema = z.object({
  revision_id: idSchema,
  spec_id: idSchema,
  superseded_by_revision_id: idSchema,
  reason: z.string().min(1),
  actor_json: jsonColumnSchema,
  dismissed_at: timestampSchema,
});
export type SpecRevisionSupersessionRow = z.infer<
  typeof specRevisionSupersessionRowSchema
>;

export const specElementVersionRowSchema = z.object({
  revision_id: idSchema,
  element_id: idSchema,
  position: z.number().int().nonnegative(),
  payload_json: jsonColumnSchema,
  payload_hash: z.string().min(1),
  element_version: z.number().int().positive(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecElementVersionRow = z.infer<typeof specElementVersionRowSchema>;

export const specSchema = z
  .object({
    id: idSchema,
    projectPath: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
    gatePolicy: specGatePolicySchema,
    abandonedAt: nullableTimestampSchema,
    abandonedReason: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type Spec = z.infer<typeof specSchema>;

export const specAliasSchema = z
  .object({
    projectPath: z.string().min(1),
    slug: z.string().min(1),
    specId: idSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type SpecAlias = z.infer<typeof specAliasSchema>;

export const specCounterScopeKeySchema = z
  .string()
  .regex(/^(?:R|D|T|Q|A|C:.+)$/);
export type SpecCounterScopeKey = z.infer<typeof specCounterScopeKeySchema>;

export const specCounterSchema = z
  .object({
    specId: idSchema,
    scopeKey: specCounterScopeKeySchema,
    lastNumber: z.number().int().nonnegative(),
  })
  .strict();
export type SpecCounter = z.infer<typeof specCounterSchema>;

export const specElementSchema = z
  .object({
    id: idSchema,
    specId: idSchema,
    kind: specElementKindSchema,
    number: z.number().int().positive().nullable(),
    parentElementId: nullableIdSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type SpecElement = z.infer<typeof specElementSchema>;

export const specRevisionSchema = z
  .object({
    id: idSchema,
    specId: idSchema,
    number: z.number().int().positive(),
    state: specRevisionStateSchema,
    authoringStage: specAuthoringStageSchema,
    basedOnRevisionId: nullableIdSchema,
    contentHash: z.string().nullable(),
    proposedAt: nullableTimestampSchema,
    approvedAt: nullableTimestampSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type SpecRevision = z.infer<typeof specRevisionSchema>;

/**
 * The durable marker a dismissed superseded proposal leaves behind (#50). It
 * is a satellite of the revision rather than columns on it: `withdrawn` stays
 * the one lifecycle state, and the reader that asks "why did this attempt
 * end?" gets the superseding revision, the human who dismissed it, and their
 * reason from one row.
 */
export const specRevisionSupersessionSchema = z
  .object({
    revisionId: idSchema,
    specId: idSchema,
    supersededByRevisionId: idSchema,
    reason: z.string().min(1),
    actor: actorProvenanceSchema,
    dismissedAt: timestampSchema,
  })
  .strict();
export type SpecRevisionSupersession = z.infer<
  typeof specRevisionSupersessionSchema
>;

export const specElementVersionSchema = z
  .object({
    revisionId: idSchema,
    elementId: idSchema,
    position: z.number().int().nonnegative(),
    payload: specElementPayloadSchema,
    payloadHash: z.string().min(1),
    elementVersion: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();
export type SpecElementVersion = z.infer<typeof specElementVersionSchema>;

export const specRevisionElementSchema = z
  .object({
    element: specElementSchema,
    version: specElementVersionSchema,
  })
  .strict();
export type SpecRevisionElement = z.infer<typeof specRevisionElementSchema>;

export const specRevisionSnapshotSchema = z
  .object({
    revision: specRevisionSchema,
    elements: z.array(specRevisionElementSchema),
  })
  .strict();
export type SpecRevisionSnapshot = z.infer<typeof specRevisionSnapshotSchema>;

export const specApprovalRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  subject_kind: specApprovalSubjectKindSchema,
  element_id: nullableIdSchema,
  revision_id: idSchema,
  approver: z.string().min(1),
  granted_at: timestampSchema,
  validity: specApprovalValiditySchema,
});
export type SpecApprovalRow = z.infer<typeof specApprovalRowSchema>;

export const specGateAdmissionRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  gate: specGateSchema,
  basis: specGateAdmissionBasisSchema,
  approval_id: nullableIdSchema,
  revision_id: nullableIdSchema,
  execution_id: nullableIdSchema,
  actor_json: jsonColumnSchema,
  created_at: timestampSchema,
});
export type SpecGateAdmissionRow = z.infer<typeof specGateAdmissionRowSchema>;

export const specQuestionRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  number: z.number().int().positive(),
  element_id: nullableIdSchema,
  text: z.string(),
  provenance_json: jsonColumnSchema,
  status: specQuestionStatusSchema,
  answer: z.string().nullable(),
  answered_at: nullableTimestampSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecQuestionRow = z.infer<typeof specQuestionRowSchema>;

export const specAssumptionRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  number: z.number().int().positive(),
  element_id: nullableIdSchema,
  text: z.string(),
  proposed_by_json: jsonColumnSchema,
  disposition: specAssumptionDispositionSchema,
  disposed_at: nullableTimestampSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecAssumptionRow = z.infer<typeof specAssumptionRowSchema>;

export const specCommentRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  thread_id: idSchema,
  parent_comment_id: nullableIdSchema,
  element_id: idSchema,
  anchor_json: jsonColumnSchema,
  revision_id: idSchema,
  body: z.string(),
  author_json: jsonColumnSchema,
  blocking: sqliteBooleanSchema,
  resolution: specCommentResolutionSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecCommentRow = z.infer<typeof specCommentRowSchema>;

export const specEvidenceRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  criterion_element_id: idSchema,
  revision_id: idSchema,
  kind: evidenceKindSchema,
  ref_json: jsonColumnSchema,
  evaluated_state_json: jsonColumnSchema,
  producer_json: jsonColumnSchema,
  execution_id: nullableIdSchema,
  source_event_id: z.number().int().positive().nullable(),
  created_at: timestampSchema,
});
export type SpecEvidenceRow = z.infer<typeof specEvidenceRowSchema>;

export const specProofVerdictRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  criterion_element_id: idSchema,
  revision_id: idSchema,
  execution_id: nullableIdSchema,
  verdict_kind: specProofVerdictKindSchema,
  evidence_ids_json: jsonColumnSchema,
  verdict_at: timestampSchema,
  stale_at: nullableTimestampSchema,
  stale_reason: z.string().nullable(),
});
export type SpecProofVerdictRow = z.infer<typeof specProofVerdictRowSchema>;

export const specWaiverRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  criterion_element_id: idSchema,
  revision_id: idSchema,
  reason: z.string().min(1),
  waived_at: timestampSchema,
  stale: sqliteBooleanSchema,
});
export type SpecWaiverRow = z.infer<typeof specWaiverRowSchema>;

export const specCriterionDispositionRowSchema = z.object({
  execution_id: idSchema,
  criterion_element_id: idSchema,
  disposition: specCriterionDispositionSchema,
  waiver_id: nullableIdSchema,
  delivered_by_execution_id: nullableIdSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecCriterionDispositionRow = z.infer<
  typeof specCriterionDispositionRowSchema
>;

export const specTaskClaimRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  task_element_id: idSchema,
  execution_id: nullableIdSchema,
  actor_json: jsonColumnSchema,
  evidence_ids_json: jsonColumnSchema,
  claimed_at: timestampSchema,
  status: specTaskClaimStatusSchema,
});
export type SpecTaskClaimRow = z.infer<typeof specTaskClaimRowSchema>;

export const specExecutionRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  revision_id: idSchema,
  scope_json: jsonColumnSchema,
  state: specExecutionStateSchema,
  execution_start_dial: specGateDialSchema.nullable(),
  workflow_definition_id: idSchema,
  workflow_definition_revision: z.number().int().positive().nullable(),
  workflow_execution_id: nullableIdSchema,
  session_name: z.string().nullable(),
  delivered_at: nullableTimestampSchema,
  abandoned_reason: z.string().nullable(),
  /** Non-null exactly while `state` is `abandoning` (design §10). */
  cleanup_phase: specExecutionCleanupPhaseSchema.nullable(),
  /**
   * The cleanup target, pinned when the coordinator enters `abandoning`. Every
   * phase, every retry, and the downstream orphan verification read this one
   * id, so the run being released can never drift from the run the abandonment
   * accepted responsibility for.
   */
  linked_workflow_execution_id: nullableIdSchema,
  /**
   * Why the last cleanup attempt stopped, and when. Durable because a
   * coordinator that fails mid-chain is resumed by re-running the SAME
   * command: without the recorded cause, the operator sees only a row parked
   * in `abandoning` with no way to tell a live-run refusal from an infra fault.
   */
  cleanup_last_error: z.string().nullable(),
  cleanup_last_error_at: nullableTimestampSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecExecutionRow = z.infer<typeof specExecutionRowSchema>;

export const specLinkRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  object_kind: specLinkObjectKindSchema,
  object_ref_json: jsonColumnSchema,
  direction: z.string().min(1),
  category: specLinkCategorySchema,
  snapshot_json: jsonColumnSchema.nullable(),
  element_ids_json: jsonColumnSchema.nullable(),
  actor_json: jsonColumnSchema,
  created_at: timestampSchema,
});
export type SpecLinkRow = z.infer<typeof specLinkRowSchema>;

/**
 * A `DeliveryPlanAttempt`'s lifecycle. The three unlaunched states a reopen
 * has to return to draft are `proposed`, `approved`, and `parked`; `launched`
 * is the one that refuses, because the compiled candidate is already running.
 */
export const deliveryPlanAttemptStatusSchema = z.enum([
  "draft",
  "proposed",
  "approved",
  "parked",
  "launched",
  "abandoned",
]);
export type DeliveryPlanAttemptStatus = z.infer<
  typeof deliveryPlanAttemptStatusSchema
>;

/**
 * The attempt is keyed by its own id, independently of both evergreen
 * revisions and workflow executions: it exists before the execution does, and
 * a later evergreen amendment can never fork or block it (design §4). The
 * pinned revision and the delta basis are references, not identity.
 */
export const specDeliveryPlanAttemptRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  pinned_revision_id: idSchema,
  /** The earlier delivered execution the seeding delta was computed against. */
  delta_basis_execution_id: nullableIdSchema,
  status: deliveryPlanAttemptStatusSchema,
  /** Compare-and-swap token for draft edits; bumped by every edit and reopen. */
  draft_revision: z.number().int().positive(),
  content_json: jsonColumnSchema,
  /** The frozen snapshot the live proposal points at; null while drafting. */
  proposed_snapshot_id: nullableIdSchema,
  approval_json: jsonColumnSchema.nullable(),
  /**
   * The durable prelaunch review record `spec start --park` writes. It
   * outlives the approval a reopen clears, because the parked candidate's hash
   * is what a later launch refusal names as the old one.
   */
  prelaunch_json: jsonColumnSchema.nullable(),
  launched_execution_id: nullableIdSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecDeliveryPlanAttemptRow = z.infer<
  typeof specDeliveryPlanAttemptRowSchema
>;

/**
 * An immutable proposal snapshot. Nothing ever updates a row here: a reopen
 * bumps the attempt's draft revision and clears its approval, and the prior
 * snapshots stay readable exactly as proposed.
 */
export const specDeliveryPlanSnapshotRowSchema = z.object({
  id: idSchema,
  attempt_id: idSchema,
  /** The attempt draft revision this snapshot froze. */
  draft_revision: z.number().int().positive(),
  plan_hash: z.string().min(1),
  content_json: jsonColumnSchema,
  pinned_revision_id: idSchema,
  proposed_at: timestampSchema,
  proposed_by_json: jsonColumnSchema,
});
export type SpecDeliveryPlanSnapshotRow = z.infer<
  typeof specDeliveryPlanSnapshotRowSchema
>;

/**
 * The compiled candidate a proposal materialized: the exact
 * `WorkflowSemanticDefinition` bytes a human approves and a launch runs. It is
 * immutable and one-to-one with its snapshot, so `compiled_definition_hash` can
 * be compared against a launched definition without re-deriving anything
 * (`exact-approval`).
 */
export const specDeliveryPlanCandidateRowSchema = z.object({
  id: idSchema,
  attempt_id: idSchema,
  snapshot_id: idSchema,
  compiled_definition_hash: z.string().min(1),
  definition_json: jsonColumnSchema,
  materialized_at: timestampSchema,
});
export type SpecDeliveryPlanCandidateRow = z.infer<
  typeof specDeliveryPlanCandidateRowSchema
>;

/**
 * A review note anchored to one context of one attempt. `context_id` is
 * deliberately NOT a foreign key: contexts live inside the attempt's document
 * blob, and a comment must outlive the context it discusses so a later edit
 * that removes that context surfaces the note as a visible orphan anchor
 * rather than silently deleting reviewed work.
 */
export const specDeliveryPlanCommentRowSchema = z.object({
  id: idSchema,
  attempt_id: idSchema,
  context_id: z.string().min(1),
  body: z.string().min(1),
  author_json: jsonColumnSchema,
  created_at: timestampSchema,
});
export type SpecDeliveryPlanCommentRow = z.infer<
  typeof specDeliveryPlanCommentRowSchema
>;

/**
 * Work a running execution found and deliberately did not do (design §11). It
 * is the durable half of the non-blocking capture path: the run keeps its
 * pinned scope, and the next seeded attempt places the discovery as a task.
 *
 * It is stored against the execution rather than as a task element on an
 * evergreen amendment because a discovery is plan content, not spec content —
 * the evergreen spec carries requirements, decisions, and criteria, and the
 * `DeliveryPlanAttempt` carries the work.
 */
export const specDeliveryDiscoveryRowSchema = z.object({
  id: idSchema,
  spec_id: idSchema,
  /** The running execution the discovery was captured against. */
  execution_id: idSchema,
  /** The launched attempt behind that execution; null for a legacy run. */
  attempt_id: nullableIdSchema,
  /** The revision the run pinned — where the discovery's ids resolve. */
  pinned_revision_id: idSchema,
  /** The `taskElementPayloadSchema` body, minus its fixed kind. */
  discovered_task_json: jsonColumnSchema,
  /** Non-null when this capture also abandoned the run it was found in. */
  blocking_reason: z.string().min(1).nullable(),
  captured_by_json: jsonColumnSchema,
  captured_at: timestampSchema,
});
export type SpecDeliveryDiscoveryRow = z.infer<
  typeof specDeliveryDiscoveryRowSchema
>;

/** The capture payload a discovery row carries, parsed out of its column. */
export const discoveredTaskSchema = taskElementPayloadSchema.omit({
  kind: true,
});
export type DiscoveredTask = z.infer<typeof discoveredTaskSchema>;

export const specEventRowSchema = z.object({
  id: z.number().int().positive(),
  spec_id: idSchema,
  occurred_at: timestampSchema,
  event_type: specEventTypeSchema,
  actor_json: jsonColumnSchema,
  payload_json: jsonColumnSchema,
});
export type SpecEventRow = z.infer<typeof specEventRowSchema>;
