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

export const evidenceKindSchema = z.enum([
  "diff",
  "commit",
  "test_run",
  "validator_verdict",
  "screenshot",
  "human_signoff",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const validationStrategySchema = z
  .object({
    kinds: z.array(evidenceKindSchema),
    note: z.string().optional(),
  })
  .strict();
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

export const taskElementPayloadSchema = z
  .object({
    kind: z.literal("task"),
    title: z.string(),
    instructions: z.string(),
    tracedRequirementElementIds: z.array(idSchema),
    tracedDecisionElementIds: z.array(idSchema),
    coveredCriterionElementIds: z.array(idSchema),
    dependsOnTaskElementIds: z.array(idSchema),
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
  "lint_blocked",
  "stale_element",
  "unresolvable_evidence",
  "invalid_scope",
  "revision_not_approved",
  "execution_active",
  "human_act_required",
  "amendment_required",
  "integrity_mismatch",
  "region_locked",
  "delivery_gate_failed",
  "slug_taken",
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

export const specEventTypeSchema = z.union([
  specSseEventTypeSchema,
  specReviewEventTypeSchema,
  specInterventionEventTypeSchema,
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
]);
export type SpecExecutionState = z.infer<typeof specExecutionStateSchema>;

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
  based_on_revision_id: nullableIdSchema,
  content_hash: z.string().nullable(),
  proposed_at: nullableTimestampSchema,
  approved_at: nullableTimestampSchema,
  created_at: timestampSchema,
});
export type SpecRevisionRow = z.infer<typeof specRevisionRowSchema>;

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
    basedOnRevisionId: nullableIdSchema,
    contentHash: z.string().nullable(),
    proposedAt: nullableTimestampSchema,
    approvedAt: nullableTimestampSchema,
    createdAt: timestampSchema,
  })
  .strict();
export type SpecRevision = z.infer<typeof specRevisionSchema>;

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
  workflow_definition_id: idSchema,
  workflow_execution_id: nullableIdSchema,
  session_name: z.string().nullable(),
  delivered_at: nullableTimestampSchema,
  abandoned_reason: z.string().nullable(),
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

export const specEventRowSchema = z.object({
  id: z.number().int().positive(),
  spec_id: idSchema,
  occurred_at: timestampSchema,
  event_type: specEventTypeSchema,
  actor_json: jsonColumnSchema,
  payload_json: jsonColumnSchema,
});
export type SpecEventRow = z.infer<typeof specEventRowSchema>;
