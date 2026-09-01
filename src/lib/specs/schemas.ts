import { z } from "zod";
// The one canonical spec-slug definition. `handles` is itself zod-only, so the
// module's dependency set stays {zod} rather than gaining a second slug regex
// that could drift from the one every other caller validates against.
import { specSlugSchema } from "./handles";

const idSchema = z.string().min(1);
const timestampSchema = z.string().min(1);
const jsonColumnSchema = z.string();
const nullableIdSchema = idSchema.nullable();
const nullableTimestampSchema = timestampSchema.nullable();
const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

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

/**
 * The lane an author intends a task's work to run on. It is spec content, not
 * graph structure: nothing derives a lane from it. The delivery-plan author
 * reads it while placing contexts in the authored launch, which is the only
 * place lane placement is decided.
 *
 * The grammar is still the lane-id grammar `laneIdViolation` owns in
 * `@/lib/workflow-graph/lane-identity`, because an intent that could never be
 * spelled as a lane is worth refusing at the point it is written: a lane id
 * becomes a git branch name and a worktree path segment, so the two must accept
 * exactly the same names. It is mirrored here rather than imported because this
 * module is deliberately dependency-free apart from Zod — importing it would
 * drag the jobs, conversations, and agent-backend schema graphs into every
 * reader of a spec payload. `schemas.test.ts` pins the mirror against the
 * owning predicate so it cannot drift.
 *
 * Reserved lane identity (`session`, `__session__`) is NOT refused here: those
 * names are grammatical, and the refusal that knows what they mean lives at the
 * authored-placement choke point in the graph.
 */
export const executionLaneSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const invalid =
      !/^[A-Za-z0-9_.-]+$/.test(value) ||
      value.startsWith(".") ||
      value.startsWith("-") ||
      value.includes("..") ||
      value.endsWith(".") ||
      value.endsWith("-") ||
      value.endsWith(".lock");
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        message:
          "executionLane becomes a branch name and a worktree path segment: it must match /^[A-Za-z0-9_.-]+$/, must not start with '.' or '-', must not contain '..', and must not end with '.', '-', or '.lock'",
      });
    }
  });
export type ExecutionLane = z.infer<typeof executionLaneSchema>;

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
    executionLane: executionLaneSchema.optional(),
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

/**
 * The claim that an imported spec's work already shipped outside this system.
 * It carries who recorded the claim and which source it came from, and nothing
 * else: there is no verdict, evidence ref, or criterion closure here, because
 * external delivery is testimony rather than proof and the delivery gate never
 * reads it.
 */
export const externalDeliverySchema = z
  .object({
    /**
     * Stricter than this module's general `timestampSchema`, which only demands
     * a non-empty string. Every other spec timestamp is minted by this system;
     * this one arrives from an external document by way of an authoring agent,
     * so it is the one date nothing here has already validated. Free text would
     * persist an unorderable value no surface could honestly render beside the
     * system's own timestamps.
     */
    at: z.iso.datetime(),
    actor: actorProvenanceSchema,
    source: z.object({ label: z.string().min(1) }).strict(),
  })
  .strict();
export type ExternalDelivery = z.infer<typeof externalDeliverySchema>;

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
  // An ordinary update that names a parent other than the one the element is
  // stored under. Distinct from the `parent_changed` reason inside
  // `historical_element_id`, which judges the parent a REINTRODUCTION comes
  // back under: this one refuses moving an element the revision already
  // carries. Neither has a retry — a different parent needs a different
  // element.
  "parent_immutable",
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
  "authoring_unsettled",
  // A launch whose spec-side records committed but whose workflow start did
  // not take. Distinct from `integrity_mismatch`: nothing about the approved
  // candidate is wrong, so the remedy is a retry or an abandon of the run that
  // now exists — never a re-approval.
  "workflow_unavailable",
  "authoring_agent_required",
  "stale_attention_record",
  "stale_citation_set",
  "attention_state_conflict",
  "idempotency_conflict",
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
    /**
     * One server-authored sentence saying why the constraint exists, for the
     * refusals whose friction is the product rather than a defect. It asserts
     * the value ("this is deliberate: X") instead of apologizing, because an
     * agent told a rule is unfortunate goes looking for the way around it.
     * Absent on refusals whose unmet condition already carries its own reason.
     */
    rationale: z.string().optional(),
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
  "spec-delivery-plan-changed",
]);
export type SpecSseEventType = z.infer<typeof specSseEventTypeSchema>;

export const specReviewEventTypeSchema = z.enum([
  "spec-review-commented",
  "spec-review-changes-requested",
  "spec-review-item-approved",
  "spec-review-item-unapproved",
  "spec-review-revision-signed-off",
  "spec-review-record-mutated",
  "spec-assumption-citations-mutated",
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

export const specAuthoringEventTypeSchema = z.enum([
  "spec-authoring-returned-to-requirements",
]);
export type SpecAuthoringEventType = z.infer<
  typeof specAuthoringEventTypeSchema
>;

/**
 * Durable audit trail for `DeliveryPlanAttempt` transitions. The matching
 * typed SSE event refreshes live plan review surfaces after these rows commit.
 */
export const specDeliveryPlanEventTypeSchema = z.enum([
  "spec-delivery-plan-opened",
  "spec-delivery-plan-proposed",
  "spec-delivery-plan-reopened",
  "spec-delivery-plan-transitioned",
  "spec-delivery-plan-commented",
  "spec-delivery-plan-reaffirmed",
  "spec-delivery-plan-candidate-migrated",
]);
export type SpecDeliveryPlanEventType = z.infer<
  typeof specDeliveryPlanEventTypeSchema
>;

/**
 * Durable-only record that a spec entered the system by import rather than by
 * authoring. It is not part of the SSE union: an import commits before any
 * subscriber can be watching the spec it creates, and the row exists so the
 * origin of a born-approved spec is reconstructable from the event log alone.
 */
export const specImportEventTypeSchema = z.enum(["spec_imported"]);
export type SpecImportEventType = z.infer<typeof specImportEventTypeSchema>;

/**
 * What an import counted into the spec, as it rides the durable
 * `spec_imported` payload. A schema rather than a bare interface because the
 * only reader of a committed payload is a parser: history renders these counts
 * back from the event log, and an unparsed shape would let a drifted payload
 * render as a confident wrong number.
 */
export const specImportedCountsSchema = z
  .object({
    sections: z.number().int().nonnegative(),
    requirements: z.number().int().nonnegative(),
    criteria: z.number().int().nonnegative(),
    decisions: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
    assumptions: z.number().int().nonnegative(),
  })
  .strict();
export type SpecImportedCounts = z.infer<typeof specImportedCountsSchema>;

/**
 * The durable `spec_imported` payload. Not `.strict()`: this schema speaks only
 * for the fields the provenance surfaces read, and a payload that later carries
 * more must still parse here.
 */
export const specImportedEventPayloadSchema = z.object({
  source: z.object({ label: z.string().min(1) }),
  revisionId: idSchema,
  counts: specImportedCountsSchema,
});
export type SpecImportedEventPayload = z.infer<
  typeof specImportedEventPayloadSchema
>;

export const specEventTypeSchema = z.union([
  specSseEventTypeSchema,
  specReviewEventTypeSchema,
  specInterventionEventTypeSchema,
  specAuthoringEventTypeSchema,
  specDeliveryPlanEventTypeSchema,
  specImportEventTypeSchema,
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

export const specCitationContractVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
]);
export type SpecCitationContractVersion = z.infer<
  typeof specCitationContractVersionSchema
>;

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

/**
 * Why a gate is admitted. `import` records that an imported spec was born past
 * an authoring gate on the strength of an external document — it is provenance,
 * never a human act and never proof: no approval row backs it, and the delivery
 * gate does not read admissions on this basis.
 */
export const specGateAdmissionBasisSchema = z.enum([
  "human_approval",
  "notify_policy",
  "off_policy",
  "import",
]);
export type SpecGateAdmissionBasis = z.infer<
  typeof specGateAdmissionBasisSchema
>;

export const specQuestionStatusSchema = z.enum([
  "open",
  "answered",
  "withdrawn",
]);
export type SpecQuestionStatus = z.infer<typeof specQuestionStatusSchema>;

export const specAssumptionDispositionSchema = z.enum([
  "proposed",
  "confirmed",
  "rejected",
  "deferred",
  "withdrawn",
]);
export type SpecAssumptionDisposition = z.infer<
  typeof specAssumptionDispositionSchema
>;

function questionLifecycleIsConsistent(input: {
  status: SpecQuestionStatus;
  answer: string | null;
  answeredAt: string | null;
  withdrawnAt: string | null;
}): boolean {
  if (input.status === "open") {
    return (
      input.answer === null &&
      input.answeredAt === null &&
      input.withdrawnAt === null
    );
  }
  if (input.status === "answered") {
    return (
      input.answer !== null &&
      input.answer.length > 0 &&
      input.answeredAt !== null &&
      input.withdrawnAt === null
    );
  }
  return (
    input.answer === null &&
    input.answeredAt === null &&
    input.withdrawnAt !== null
  );
}

function assumptionLifecycleIsConsistent(input: {
  disposition: SpecAssumptionDisposition;
  disposedAt: string | null;
  withdrawnAt: string | null;
}): boolean {
  if (input.disposition === "proposed") {
    return input.disposedAt === null && input.withdrawnAt === null;
  }
  if (input.disposition === "withdrawn") {
    return input.disposedAt === null && input.withdrawnAt !== null;
  }
  return input.disposedAt !== null && input.withdrawnAt === null;
}

export const specAssumptionCitationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    captureKind: z.enum(["native", "legacy_backfill"]),
    capturedAt: timestampSchema,
    assumptionId: idSchema,
    number: z.number().int().positive(),
    recordVersion: z.number().int().positive(),
    text: z.string(),
    elementId: nullableIdSchema,
    proposedBy: actorProvenanceSchema,
    disposition: specAssumptionDispositionSchema,
    disposedAt: nullableTimestampSchema,
    withdrawnAt: nullableTimestampSchema,
    supersedesAssumptionId: nullableIdSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (!assumptionLifecycleIsConsistent(snapshot)) {
      ctx.addIssue({
        code: "custom",
        message:
          "citation snapshot lifecycle fields must agree with its disposition",
      });
    }
  });
export type SpecAssumptionCitationSnapshot = z.infer<
  typeof specAssumptionCitationSnapshotSchema
>;

export const specReviewRecordOperationSchema = z.enum([
  "opened",
  "proposed",
  "imported",
  "edited",
  "answered",
  "disposed",
  "withdrawn",
  "superseded",
]);
export type SpecReviewRecordOperation = z.infer<
  typeof specReviewRecordOperationSchema
>;

const specQuestionAuditSnapshotSchema = z
  .object({
    kind: z.literal("question"),
    recordId: idSchema,
    number: z.number().int().positive(),
    recordVersion: z.number().int().positive(),
    text: z.string(),
    elementId: nullableIdSchema,
    provenance: actorProvenanceSchema,
    status: specQuestionStatusSchema,
    answer: z.string().nullable(),
    answeredAt: nullableTimestampSchema,
    withdrawnAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const specAssumptionAuditSnapshotSchema = z
  .object({
    kind: z.literal("assumption"),
    recordId: idSchema,
    number: z.number().int().positive(),
    recordVersion: z.number().int().positive(),
    text: z.string(),
    elementId: nullableIdSchema,
    proposedBy: actorProvenanceSchema,
    disposition: specAssumptionDispositionSchema,
    disposedAt: nullableTimestampSchema,
    withdrawnAt: nullableTimestampSchema,
    supersedesAssumptionId: nullableIdSchema,
    supersededByAssumptionId: nullableIdSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const specRecordAuditSnapshotSchema = z
  .discriminatedUnion("kind", [
    specQuestionAuditSnapshotSchema,
    specAssumptionAuditSnapshotSchema,
  ])
  .superRefine((snapshot, ctx) => {
    if (snapshot.kind === "question") {
      if (!questionLifecycleIsConsistent(snapshot)) {
        ctx.addIssue({
          code: "custom",
          message: "question audit lifecycle fields must agree with status",
        });
      }
      return;
    }

    if (!assumptionLifecycleIsConsistent(snapshot)) {
      ctx.addIssue({
        code: "custom",
        message:
          "assumption audit lifecycle fields must agree with disposition",
      });
    }
  });
export type SpecRecordAuditSnapshot = z.infer<
  typeof specRecordAuditSnapshotSchema
>;

export const specReviewRecordMutatedEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.enum(["question", "assumption"]),
    recordId: idSchema,
    recordNumber: z.number().int().positive(),
    attentionId: idSchema,
    operation: specReviewRecordOperationSchema,
    reason: z.string().min(1).optional(),
    active: z.boolean(),
    successorAssumptionId: idSchema.optional(),
    before: specRecordAuditSnapshotSchema.nullable(),
    after: specRecordAuditSnapshotSchema,
  })
  .strict()
  .superRefine((event, ctx) => {
    const creationOperation = ["opened", "proposed", "imported"].includes(
      event.operation,
    );
    if ((event.before === null) !== creationOperation) {
      ctx.addIssue({
        code: "custom",
        message:
          "before is null exactly for opened, proposed, and imported records",
        path: ["before"],
      });
    }

    const questionOperation = [
      "opened",
      "imported",
      "edited",
      "answered",
      "withdrawn",
    ].includes(event.operation);
    const assumptionOperation = [
      "proposed",
      "imported",
      "edited",
      "disposed",
      "withdrawn",
      "superseded",
    ].includes(event.operation);
    if (
      (event.recordKind === "question" && !questionOperation) ||
      (event.recordKind === "assumption" && !assumptionOperation)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "record mutation operation must match the record kind",
        path: ["operation"],
      });
    }

    const snapshots =
      event.before === null ? [event.after] : [event.before, event.after];
    if (
      snapshots.some(
        (snapshot) =>
          snapshot.kind !== event.recordKind ||
          snapshot.recordId !== event.recordId ||
          snapshot.number !== event.recordNumber,
      ) ||
      event.attentionId !== event.recordId
    ) {
      ctx.addIssue({
        code: "custom",
        message: "event identity must match every record snapshot",
      });
    }

    if (
      event.before !== null &&
      event.after.recordVersion !== event.before.recordVersion + 1
    ) {
      ctx.addIssue({
        code: "custom",
        message: "record mutation events increment recordVersion exactly once",
        path: ["after", "recordVersion"],
      });
    }

    const shouldBeActive =
      event.operation !== "superseded" &&
      ((event.after.kind === "question" && event.after.status === "open") ||
        (event.after.kind === "assumption" &&
          event.after.disposition === "proposed"));
    if (event.active !== shouldBeActive) {
      ctx.addIssue({
        code: "custom",
        message: "active must reflect the resulting attention lifecycle",
        path: ["active"],
      });
    }

    const needsReason = ["withdrawn", "superseded"].includes(event.operation);
    if (needsReason !== (event.reason !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "reason is present exactly for withdrawal and supersession",
        path: ["reason"],
      });
    }

    const needsSuccessor = event.operation === "superseded";
    if (needsSuccessor !== (event.successorAssumptionId !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "successorAssumptionId is present exactly for supersession",
        path: ["successorAssumptionId"],
      });
    }
  });
export type SpecReviewRecordMutatedEventPayload = z.infer<
  typeof specReviewRecordMutatedEventPayloadSchema
>;

const specCitationAuditEntrySchema = z
  .object({
    elementId: idSchema,
    assumptionId: idSchema,
    snapshot: specAssumptionCitationSnapshotSchema,
  })
  .strict();

const specCitationRefreshAuditEntrySchema = z
  .object({
    elementId: idSchema,
    assumptionId: idSchema,
    beforeSnapshot: specAssumptionCitationSnapshotSchema,
    afterSnapshot: specAssumptionCitationSnapshotSchema,
  })
  .strict();

export const specAssumptionCitationsMutatedEventPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    revisionId: idSchema,
    beforeCitationVersion: z.number().int().positive(),
    afterCitationVersion: z.number().int().positive(),
    beforeCitationHash: sha256Schema,
    afterCitationHash: sha256Schema,
    added: z.array(specCitationAuditEntrySchema),
    removed: z.array(specCitationAuditEntrySchema),
    refreshed: z.array(specCitationRefreshAuditEntrySchema),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.afterCitationVersion !== event.beforeCitationVersion + 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "citation mutation events increment citationVersion exactly once",
        path: ["afterCitationVersion"],
      });
    }
    if (event.beforeCitationHash === event.afterCitationHash) {
      ctx.addIssue({
        code: "custom",
        message: "citation mutation events must change the citation hash",
        path: ["afterCitationHash"],
      });
    }
    if (
      event.added.length === 0 &&
      event.removed.length === 0 &&
      event.refreshed.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "citation mutation events must contain at least one delta",
      });
    }
  });
export type SpecAssumptionCitationsMutatedEventPayload = z.infer<
  typeof specAssumptionCitationsMutatedEventPayloadSchema
>;

const specAttentionAttachmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spec") }).strict(),
  z
    .object({
      kind: z.literal("element"),
      handle: z.string().min(1),
    })
    .strict(),
]);

const uniqueElementHandlesSchema = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((handles, ctx) => {
    if (new Set(handles).size !== handles.length) {
      ctx.addIssue({
        code: "custom",
        message: "element handles must be unique",
      });
    }
  });

const specCitationIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preserve") }).strict(),
  z
    .object({
      kind: z.literal("replace"),
      revisionId: idSchema,
      elementHandles: uniqueElementHandlesSchema,
    })
    .strict(),
]);

const specQuestionEditPayloadSchema = z
  .object({
    kind: z.literal("question"),
    text: z.string().min(1).optional(),
    attachment: specAttentionAttachmentSchema.optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.text === undefined && payload.attachment === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a question edit must change text or attachment",
      });
    }
  });

const specAssumptionEditPayloadSchema = z
  .object({
    kind: z.literal("assumption"),
    text: z.string().min(1).optional(),
    attachment: specAttentionAttachmentSchema.optional(),
    citationIntent: specCitationIntentSchema.optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.text === undefined && payload.attachment === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "an assumption edit must change text or attachment",
      });
    }
    if (
      payload.attachment !== undefined &&
      payload.citationIntent === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "an assumption attachment edit must state whether citations are preserved or replaced",
        path: ["citationIntent"],
      });
    }
  });

export const specAttentionEditPayloadSchema = z.union([
  specQuestionEditPayloadSchema,
  specAssumptionEditPayloadSchema,
]);
export type SpecAttentionEditPayload = z.infer<
  typeof specAttentionEditPayloadSchema
>;

const specSupersessionCitationsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clear") }).strict(),
  z
    .object({
      kind: z.literal("replace"),
      elementHandles: uniqueElementHandlesSchema,
    })
    .strict(),
]);

export const specSupersedeAssumptionPayloadSchema = z
  .object({
    operationId: idSchema,
    reason: z.string().min(1),
    text: z.string().min(1),
    attachment: specAttentionAttachmentSchema,
    citations: specSupersessionCitationsSchema,
  })
  .strict();
export type SpecSupersedeAssumptionPayload = z.infer<
  typeof specSupersedeAssumptionPayloadSchema
>;

const specAttentionReceiptOperationSchema = z.enum([
  "edited",
  "withdrawn",
  "superseded",
  "cited",
  "uncited",
  "answered",
  "disposed",
]);

export const specAttentionMutationReceiptSchema = z
  .object({
    operation: specAttentionReceiptOperationSchema,
    recordKind: z.enum(["question", "assumption"]),
    recordId: idSchema,
    recordHandle: z.string().min(1),
    previousRecordVersion: z.number().int().positive(),
    newRecordVersion: z.number().int().positive(),
    lifecycle: z.union([
      specQuestionStatusSchema,
      specAssumptionDispositionSchema,
    ]),
    draftRevisionId: nullableIdSchema,
    previousCitationVersion: z.number().int().positive().nullable(),
    newCitationVersion: z.number().int().positive().nullable(),
    citationChanges: z
      .object({
        added: z.array(z.string().min(1)),
        removed: z.array(z.string().min(1)),
        refreshed: z.array(z.string().min(1)),
      })
      .strict(),
    successor: z
      .object({ id: idSchema, handle: z.string().min(1) })
      .strict()
      .optional(),
    idempotentReplay: z.boolean(),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const recordOnlyCitationAct = ["cited", "uncited"].includes(
      receipt.operation,
    );
    if (
      !receipt.idempotentReplay &&
      receipt.newRecordVersion !==
        receipt.previousRecordVersion + (recordOnlyCitationAct ? 0 : 1)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "record versions must reflect exactly one admitted mutation",
        path: ["newRecordVersion"],
      });
    }

    const hasPreviousCitationVersion = receipt.previousCitationVersion !== null;
    const hasNewCitationVersion = receipt.newCitationVersion !== null;
    if (hasPreviousCitationVersion !== hasNewCitationVersion) {
      ctx.addIssue({
        code: "custom",
        message: "citation versions are either both present or both absent",
      });
    } else if (
      !receipt.idempotentReplay &&
      receipt.previousCitationVersion !== null &&
      receipt.newCitationVersion !== receipt.previousCitationVersion + 1
    ) {
      ctx.addIssue({
        code: "custom",
        message: "citation versions must reflect exactly one admitted mutation",
        path: ["newCitationVersion"],
      });
    }

    if (
      (receipt.operation === "superseded") !==
      (receipt.successor !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "successor is present exactly for supersession",
        path: ["successor"],
      });
    }
  });
export type SpecAttentionMutationReceipt = z.infer<
  typeof specAttentionMutationReceiptSchema
>;

const specAttentionLastMutationSchema = z
  .object({
    operation: specReviewRecordOperationSchema,
    actor: actorProvenanceSchema,
    occurredAt: timestampSchema,
  })
  .strict();

const specHumanAttentionCapabilitySchema = z.union([
  z
    .object({
      kind: z.enum(["answer", "dispose"]),
      allowed: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["answer", "dispose"]),
      allowed: z.literal(false),
      code: z.enum(["terminal", "amendment_required", "read_only"]),
      blockingRevisionId: nullableIdSchema,
      instruction: z.string().min(1),
    })
    .strict(),
]);

export const specAttentionRecordPresentationSchema = z
  .object({
    state: z.enum(["current", "history"]),
    attentionActive: z.boolean(),
    lastMutation: specAttentionLastMutationSchema.nullable(),
    humanCapability: specHumanAttentionCapabilitySchema.nullable(),
  })
  .strict()
  .superRefine((presentation, ctx) => {
    if (presentation.state === "history" && presentation.attentionActive) {
      ctx.addIssue({
        code: "custom",
        message: "historical records cannot be active attention",
        path: ["attentionActive"],
      });
    }
  });
export type SpecAttentionRecordPresentation = z.infer<
  typeof specAttentionRecordPresentationSchema
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
  citation_contract_version: specCitationContractVersionSchema,
  citation_version: z.number().int().positive(),
  citation_hash: sha256Schema,
  proposed_at: nullableTimestampSchema,
  approved_at: nullableTimestampSchema,
  /** `externalDeliverySchema`; null for every revision authored here. */
  external_delivery_json: jsonColumnSchema.nullable(),
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
    citationContractVersion: specCitationContractVersionSchema,
    citationVersion: z.number().int().positive(),
    citationHash: sha256Schema,
    proposedAt: nullableTimestampSchema,
    approvedAt: nullableTimestampSchema,
    /**
     * The external-delivery claim an import carried in, or null. It sits beside
     * the lifecycle timestamps rather than among them because it proves
     * nothing: `approvedAt` is this system's own act, this is testimony about
     * another one.
     *
     * Defaulted rather than required so a payload producer older than the field
     * still satisfies the strict parse, reading as the claim it actually makes:
     * none. Absent can only ever mean null here — the sole writer is the import
     * path, and defaulting the other way would invent a delivery nobody
     * claimed. The row schema keeps the column required, so a repository that
     * stopped mapping it still fails the round-trip contract.
     */
    externalDelivery: externalDeliverySchema.nullable().default(null),
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

export const specAssumptionCitationRowSchema = z.object({
  revision_id: idSchema,
  spec_id: idSchema,
  element_id: idSchema,
  assumption_id: idSchema,
  assumption_snapshot_json: jsonColumnSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export type SpecAssumptionCitationRow = z.infer<
  typeof specAssumptionCitationRowSchema
>;

export const specAssumptionCitationSchema = z
  .object({
    revisionId: idSchema,
    specId: idSchema,
    elementId: idSchema,
    assumptionId: idSchema,
    snapshot: specAssumptionCitationSnapshotSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((citation, ctx) => {
    if (citation.snapshot.assumptionId !== citation.assumptionId) {
      ctx.addIssue({
        code: "custom",
        message: "citation identity must match its assumption snapshot",
      });
    }
  });
export type SpecAssumptionCitation = z.infer<
  typeof specAssumptionCitationSchema
>;

export const specRevisionSnapshotSchema = z
  .object({
    revision: specRevisionSchema,
    elements: z.array(specRevisionElementSchema),
    assumptionCitations: z.array(specAssumptionCitationSchema),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    for (let index = 1; index < snapshot.assumptionCitations.length; index++) {
      const previous = snapshot.assumptionCitations[index - 1];
      const current = snapshot.assumptionCitations[index];
      if (previous === undefined || current === undefined) continue;
      const previousKey = `${previous.elementId}\u0000${previous.assumptionId}`;
      const currentKey = `${current.elementId}\u0000${current.assumptionId}`;
      if (previousKey >= currentKey) {
        ctx.addIssue({
          code: "custom",
          message:
            "revision assumption citations must be unique and sorted by elementId then assumptionId",
          path: ["assumptionCitations", index],
        });
      }
    }
  });
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

export const specQuestionRowSchema = z
  .object({
    id: idSchema,
    spec_id: idSchema,
    number: z.number().int().positive(),
    element_id: nullableIdSchema,
    text: z.string(),
    provenance_json: jsonColumnSchema,
    record_version: z.number().int().positive(),
    status: specQuestionStatusSchema,
    answer: z.string().nullable(),
    answered_at: nullableTimestampSchema,
    withdrawn_at: nullableTimestampSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .superRefine((question, ctx) => {
    if (
      !questionLifecycleIsConsistent({
        status: question.status,
        answer: question.answer,
        answeredAt: question.answered_at,
        withdrawnAt: question.withdrawn_at,
      })
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "question lifecycle fields must agree with open, answered, or withdrawn status",
      });
    }
  });
export type SpecQuestionRow = z.infer<typeof specQuestionRowSchema>;

export const specAssumptionRowSchema = z
  .object({
    id: idSchema,
    spec_id: idSchema,
    number: z.number().int().positive(),
    element_id: nullableIdSchema,
    text: z.string(),
    proposed_by_json: jsonColumnSchema,
    record_version: z.number().int().positive(),
    disposition: specAssumptionDispositionSchema,
    disposed_at: nullableTimestampSchema,
    withdrawn_at: nullableTimestampSchema,
    supersedes_assumption_id: nullableIdSchema,
    supersession_operation_id: nullableIdSchema,
    supersession_request_hash: sha256Schema.nullable(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
  })
  .superRefine((assumption, ctx) => {
    if (
      !assumptionLifecycleIsConsistent({
        disposition: assumption.disposition,
        disposedAt: assumption.disposed_at,
        withdrawnAt: assumption.withdrawn_at,
      })
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "assumption lifecycle fields must agree with proposed, disposed, or withdrawn disposition",
      });
    }

    const hasPredecessor = assumption.supersedes_assumption_id !== null;
    const hasOperation = assumption.supersession_operation_id !== null;
    const hasRequestHash = assumption.supersession_request_hash !== null;
    if (
      hasPredecessor !== hasOperation ||
      hasOperation !== hasRequestHash ||
      assumption.id === assumption.supersedes_assumption_id
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "a supersession successor must name a distinct predecessor, operation id, and request hash together",
      });
    }
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

export const specDeliveryVerdictRowSchema = z.object({
  id: idSchema,
  spec_execution_id: idSchema,
  workflow_execution_id: idSchema,
  candidate_id: idSchema,
  candidate_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  criterion_element_id: idSchema,
  satisfying_context_id: idSchema,
  verdict_at: timestampSchema,
});
export type SpecDeliveryVerdictRow = z.infer<
  typeof specDeliveryVerdictRowSchema
>;

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
  workflow_definition_id: nullableIdSchema,
  workflow_definition_revision: z.number().int().positive().nullable(),
  workflow_seed_source_json: jsonColumnSchema.nullable().optional(),
  workflow_execution_binding_json: jsonColumnSchema.nullable().optional(),
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
  workflow_definition_id: nullableIdSchema,
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
/**
 * The immutable proposal snapshot. `content_json` carries the canonical frozen
 * candidate record itself — the finalized launch, binding, pinned revision and
 * draft revision — so `candidate_hash` addresses exactly the bytes sign-off
 * approves and start launches, with no second candidate artifact to drift
 * against (`exact-approval`).
 */
export const specDeliveryPlanSnapshotRowSchema = z.object({
  id: idSchema,
  attempt_id: idSchema,
  candidate_id: idSchema,
  candidate_hash: z.string().min(1),
  /** The attempt draft revision this snapshot froze. */
  draft_revision: z.number().int().positive(),
  content_json: jsonColumnSchema,
  pinned_revision_id: idSchema,
  proposed_at: timestampSchema,
  proposed_by_json: jsonColumnSchema,
  workflow_definition_id: nullableIdSchema,
  workflow_definition_revision: z.number().int().positive().nullable(),
  workflow_definition_hash: z.string().min(1).nullable(),
  binding_hash: z.string().min(1).nullable(),
});
export type SpecDeliveryPlanSnapshotRow = z.infer<
  typeof specDeliveryPlanSnapshotRowSchema
>;

export const specDeliveryPlanCandidateApprovalRowSchema = z.object({
  snapshot_id: idSchema,
  candidate_id: idSchema,
  candidate_hash: z.string().min(1),
  approved_at: timestampSchema,
  approved_by_json: jsonColumnSchema,
});
export type SpecDeliveryPlanCandidateApprovalRow = z.infer<
  typeof specDeliveryPlanCandidateApprovalRowSchema
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

/**
 * What an imported criterion's obligation says when the bundle names none. The
 * kind is machine-provable so the delivery gate can still discharge it, and the
 * note says plainly where the criterion came from: nothing in the import ever
 * presents itself as already verified.
 */
export const IMPORTED_VALIDATION_STRATEGY_NOTE =
  "Imported; not machine-verified.";

/**
 * Resolve the validation strategy an imported criterion is born with. An
 * explicit bundle strategy always wins — an authoring agent that read the
 * external source knows the obligation better than any default can.
 *
 * The default is built per call rather than shared: `kinds` is a mutable array,
 * and one caller reaching into a shared constant would rewrite the obligation
 * every later imported criterion is born with.
 */
export function resolveImportedValidationStrategy(
  strategy: ValidationStrategy | undefined,
): ValidationStrategy {
  return (
    strategy ?? {
      kinds: ["validator_verdict"],
      note: IMPORTED_VALIDATION_STRATEGY_NOTE,
    }
  );
}

/**
 * A bundle-local requirement handle. Import bundles are authored before any
 * element id exists, so decisions trace requirements by a label the bundle
 * itself defines and the importer resolves to real element ids on write.
 */
const bundleRefSchema = z.string().min(1);

export const importBundleCriterionSchema = z
  .object({
    text: z.string().min(1),
    validationStrategy: validationStrategySchema.optional(),
  })
  .strict();
export type ImportBundleCriterion = z.infer<typeof importBundleCriterionSchema>;

export const importBundleRequirementSchema = z
  .object({
    ref: bundleRefSchema.optional(),
    statement: z.string().min(1),
    priority: requirementPrioritySchema,
    risk: requirementRiskSchema,
    criteria: z.array(importBundleCriterionSchema),
  })
  .strict();
export type ImportBundleRequirement = z.infer<
  typeof importBundleRequirementSchema
>;

export const importBundleDecisionSchema = z
  .object({
    title: z.string().min(1),
    chosenApproach: z.string().min(1),
    rejectedAlternatives: z.array(rejectedAlternativeSchema),
    reason: z.string().min(1),
    traces: z.array(bundleRefSchema),
  })
  .strict();
export type ImportBundleDecision = z.infer<typeof importBundleDecisionSchema>;

/**
 * The one document a spec import reads. It is source-agnostic on purpose: the
 * authoring agent translates whatever external format it was pointed at into
 * this shape, and `source.label` is the only place the origin is named — as
 * provenance, never as an approval.
 *
 * Section roles span the whole vocabulary including `design_narrative`: an
 * imported revision is born at the design stage, so it may carry intent and
 * design content in the same bundle.
 */
export const importBundleSchema = z
  .object({
    slug: specSlugSchema,
    name: z.string().min(1),
    gatePolicy: specGatePolicySchema.default({ preset: "contract-bearing" }),
    source: z.object({ label: z.string().min(1) }).strict(),
    sections: z.array(
      z
        .object({
          role: sectionRoleSchema,
          title: z.string(),
          body: z.string(),
        })
        .strict(),
    ),
    requirements: z.array(importBundleRequirementSchema),
    decisions: z.array(importBundleDecisionSchema),
    questions: z.array(
      z
        .object({ text: z.string().min(1), answer: z.string().optional() })
        .strict(),
    ),
    assumptions: z.array(
      z
        .object({
          text: z.string().min(1),
          disposition: specAssumptionDispositionSchema.optional(),
        })
        .strict(),
    ),
    /**
     * Whether the external source already shipped. It defaults to true because
     * a spec worth importing has usually been delivered; the record it produces
     * is external-delivery provenance, never machine proof.
     */
    delivered: z.boolean().default(true),
    /**
     * Rehearse the import instead of performing it: run every validation the
     * real import runs, report the findings and the handles it would allocate,
     * and write nothing.
     *
     * It rides on the bundle rather than beside it because the bundle document
     * is the whole import request — the action's transport parses its body with
     * this schema — so an agent moves between rehearsing and importing by
     * flipping one field on the document it already authored, rather than by
     * reaching for a second envelope this schema does not describe.
     */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type ImportBundle = z.infer<typeof importBundleSchema>;
