import { z } from "zod";
import {
  agentProfileIdSchema,
  agentProfileTierSchema,
} from "@/lib/agent-profiles/schemas";
import {
  contextOutputSchemaSchema,
  graphWorkflowContextStatusSchema,
  graphWorkflowSharedDocumentEntrySchema,
  graphWorkflowStatusSchema,
  graphWorkflowTaskSourceSchema,
  graphWorkflowTaskStatusSchema,
  graphWorkflowValidationIssueSchema,
  graphWorkflowValidatorTypeSchema,
} from "./definition-schemas";
import { graphWorkflowCircuitBreakerConditionSchema } from "./config-schemas";
import {
  graphWorkflowExecutionJoinConflictDetailSchema,
  graphWorkflowExecutionJoinKindSchema,
  graphWorkflowExecutionJoinStatusSchema,
  graphWorkflowHaltReasonSchema,
  graphWorkflowValidationAdvisorySchema,
  graphWorkflowValidationReviewArtifactSchema,
  graphWorkflowValidationSessionRefSchema,
  type GraphWorkflowValidationReviewArtifact,
} from "./schemas";

const graphWorkflowExecutionLaneIdSchema = z.string().trim().min(1);
const graphWorkflowExecutionJoinIdSchema = z.string().trim().min(1);
const graphWorkflowExecutionLaneKindSchema = z.enum(["session", "worktree"]);
const graphWorkflowExecutionLaneStatusSchema = z.enum([
  "pending",
  "active",
  "merged",
  "halted",
]);

export const graphWorkflowStatusEventSchema = z.object({
  type: z.literal("graph-workflow-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  workflowStatus: graphWorkflowStatusSchema,
  activeContextIds: z.array(z.string()).default([]),
  activeBatchIds: z.array(z.string()).default([]),
  activeJoinIds: z.array(z.string()).default([]),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  secondaryHaltReasons: z.array(graphWorkflowHaltReasonSchema).default([]),
});
export type GraphWorkflowStatusEvent = z.infer<
  typeof graphWorkflowStatusEventSchema
>;

export const graphWorkflowMergeStatusValueSchema = z.enum([
  "not-applicable",
  "pending",
  "in-progress",
  "merged-success",
  "merged-failed",
  "conflicts",
]);
export type GraphWorkflowMergeStatusValue = z.infer<
  typeof graphWorkflowMergeStatusValueSchema
>;

export const graphWorkflowCleanupStatusValueSchema = z.enum([
  "not-applicable",
  "pending",
  "removed",
  "failed",
]);
export type GraphWorkflowCleanupStatusValue = z.infer<
  typeof graphWorkflowCleanupStatusValueSchema
>;

export const graphWorkflowPendingHaltReasonEventSchema = z.object({
  type: z.literal("graph-workflow-pending-halt-reason"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable(),
});
export type GraphWorkflowPendingHaltReasonEvent = z.infer<
  typeof graphWorkflowPendingHaltReasonEventSchema
>;

export const graphWorkflowMergeStatusEventSchema = z.object({
  type: z.literal("graph-workflow-merge-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  branchName: z.string().nullable(),
  mergeStatus: graphWorkflowMergeStatusValueSchema,
  cleanupStatus: graphWorkflowCleanupStatusValueSchema,
  lastMergeError: z.string().nullable(),
});
export type GraphWorkflowMergeStatusEvent = z.infer<
  typeof graphWorkflowMergeStatusEventSchema
>;

export const graphWorkflowBatchScheduledEventSchema = z.object({
  type: z.literal("graph-workflow-batch-scheduled"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  batchId: z.string(),
  contextIds: z.array(z.string()),
});
export type GraphWorkflowBatchScheduledEvent = z.infer<
  typeof graphWorkflowBatchScheduledEventSchema
>;

export const graphWorkflowContextStatusEventSchema = z.object({
  type: z.literal("graph-workflow-context-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  status: graphWorkflowContextStatusSchema,
  remainingTaskCount: z.number().int().min(0),
  iterationCount: z.number().int().min(0),
});
export type GraphWorkflowContextStatusEvent = z.infer<
  typeof graphWorkflowContextStatusEventSchema
>;

export const graphWorkflowTaskStatusEventSchema = z.object({
  type: z.literal("graph-workflow-task-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  taskId: z.string(),
  contextId: z.string(),
  status: graphWorkflowTaskStatusSchema,
  source: graphWorkflowTaskSourceSchema,
  order: z.number().int().min(1),
  lastConversationId: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  failureMessage: z.string().nullable().optional(),
});
export type GraphWorkflowTaskStatusEvent = z.infer<
  typeof graphWorkflowTaskStatusEventSchema
>;

/**
 * One lane's spend, hoisted out of its review artifact.
 *
 * The artifact's own usage is shaped by HOW the lane ran — a conversation
 * reports turns and cost, a task run reports tokens — so a cost audit over a
 * cohort would otherwise branch per entry before it could add anything up. One
 * shape with absent figures nulled makes the sum a projection instead.
 */
const graphWorkflowValidationSpecialistUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).nullable().default(null),
    cachedInputTokens: z.number().int().min(0).nullable().default(null),
    outputTokens: z.number().int().min(0).nullable().default(null),
    costUsd: z.number().nullable().default(null),
    /** Conversation-strategy validators only; token counts are not projected. */
    apiTurns: z.number().int().min(0).nullable().default(null),
  })
  .strict();
export type GraphWorkflowValidationSpecialistUsage = z.infer<
  typeof graphWorkflowValidationSpecialistUsageSchema
>;

/**
 * What ONE cohort member decided, and who it was.
 *
 * Provenance lives on the entry rather than at the top of the aggregate: a
 * round has one candidate but many reviewers, so a single top-level session ref
 * could only ever name one of them. Identity is the frozen roster's, not the
 * live library's — `revision` and `resolvedInstructionHash` say which bytes
 * this reviewer actually received, which is what makes a verdict auditable
 * after the profile is edited.
 */
export const graphWorkflowValidationSpecialistEntrySchema = z.object({
  assignmentId: z.string().trim().min(1),
  profile: z.object({
    tier: agentProfileTierSchema,
    id: agentProfileIdSchema,
    revision: z.number().int().positive(),
  }),
  resolvedInstructionHash: z.string().trim().min(1),
  pass: z.boolean(),
  summary: z.string(),
  issues: z.array(graphWorkflowValidationIssueSchema).default([]),
  /**
   * This lane's non-blocking observations (R9), as the ROUND RECORD holds them:
   * the engine-stamped identity every later reference uses, plus the delivery
   * and disposition recorded so far.
   *
   * Defaulted rather than absent, unlike the round fields at the top of the
   * aggregate: an entry exists only for a lane that reported, and a lane
   * recorded before the advisory channel existed raised none — which is what
   * `[]` means here, not an unknown.
   *
   * A publication is a point in time, so what it carries is what had been
   * recorded when it went out. Both events publish as the round settles, and a
   * disposition is only produced by the response turn that follows a PASSING
   * round's conclusion — so a consumer that needs an advisory's final answer
   * reads the round record or the execution's advisory index, not the event it
   * first appeared on.
   */
  advisories: z.array(graphWorkflowValidationAdvisorySchema).default([]),
  sessionRef: graphWorkflowValidationSessionRefSchema.nullable().default(null),
  reviewArtifact: graphWorkflowValidationReviewArtifactSchema
    .nullable()
    .default(null),
  usage: graphWorkflowValidationSpecialistUsageSchema.nullable().default(null),
});
export type GraphWorkflowValidationSpecialistEntry = z.infer<
  typeof graphWorkflowValidationSpecialistEntrySchema
>;

/**
 * A specialist entry's usage, read off whichever artifact the lane produced.
 * Null when the lane produced no artifact at all — the honest answer, rather
 * than a row of zeroes that would understate a cohort's real cost.
 */
export function deriveGraphWorkflowValidationSpecialistUsage(
  artifact: GraphWorkflowValidationReviewArtifact | null,
): GraphWorkflowValidationSpecialistUsage | null {
  if (artifact === null || artifact.usage === null) return null;
  if (artifact.kind === "conversation") {
    return {
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      costUsd: artifact.usage.costUsd,
      apiTurns: artifact.usage.apiTurns,
    };
  }
  return {
    inputTokens: artifact.usage.inputTokens,
    cachedInputTokens: artifact.usage.cachedInputTokens,
    outputTokens: artifact.usage.outputTokens,
    costUsd: artifact.usage.costUsd,
    apiTurns: null,
  };
}

export const graphWorkflowValidationResultEventSchema = z.object({
  type: z.literal("graph-workflow-validation-result"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  validatorType: graphWorkflowValidatorTypeSchema,
  /**
   * Which check produced this result. `context_validation` is the agent/script
   * validator verdict this event has always carried; `output_schema` is a D2
   * format-turn payload the structured-output gate refused. Rows written before
   * the discriminator existed parse as `context_validation`.
   */
  kind: z
    .enum(["context_validation", "output_schema"])
    .default("context_validation"),
  pass: z.boolean(),
  summary: z.string(),
  reopenTaskIds: z.array(z.string().trim().min(1)).default([]),
  issues: z.array(graphWorkflowValidationIssueSchema).default([]),
  /**
   * The payload an `output_schema` result refused, truncated, for inspection.
   * It is deliberately confined to this failure record — a rejected candidate
   * never reaches `contextOutputs`, so no downstream reader can mistake it for
   * a validated output. Null for every other result kind.
   */
  rejectedOutput: z.string().nullable().default(null),
  /**
   * The structured-output gate's OWN bounded repair on an `output_schema`
   * refusal: turns spent, and the budget in force. This is the only repair that
   * ran for this rejection — D1's plan-repair rounds are a different mechanism
   * answering a different question, so a surface reporting the rejection's
   * repair provenance reads these and not `execution.planRepairRounds`.
   * Null for every other result kind and for rows written before the fields.
   */
  gateRepairAttempts: z.number().int().min(0).nullable().default(null),
  gateRepairBudget: z.number().int().min(0).nullable().default(null),
  /**
   * The `outputSchema` that refused this payload, snapshotted at rejection
   * time.
   *
   * A rejection outlives the contract it was measured against: the Edit-schema
   * action on the halt surfaces exists precisely so an operator can replace a
   * too-tight contract while the halt is live. Reading the context's CURRENT
   * schema to caption a past rejection would pair a payload with a contract
   * that never saw it, so the failing contract travels with the failure record
   * instead. Optional rather than defaulted: rows written before the field
   * carry no snapshot, and readers fall back to the context's contract.
   */
  rejectedAgainstSchema: contextOutputSchemaSchema.nullable().optional(),
  /**
   * The single reviewer's session and artifact. Null for a multi-specialist
   * round: several reviewers each have their own, so naming one at the top
   * would attribute the round to an arbitrary member. The per-lane refs live on
   * `specialists`, and `producerForEvent` in evidence ingestion already falls
   * back to the execution when this is absent.
   */
  sessionRef: graphWorkflowValidationSessionRefSchema.nullable().optional(),
  reviewArtifact: graphWorkflowValidationReviewArtifactSchema
    .nullable()
    .optional(),
  /**
   * Which round produced this verdict, and what each of its members decided —
   * in configured cohort order.
   *
   * Additive in the strict sense: ABSENT, not defaulted, on every publication
   * that belongs to no round. A defaulted field would rewrite the bytes of the
   * `output_schema` gate rejection and of every row written before rounds
   * existed, which is exactly the compatibility this pair of fields is required
   * not to disturb (D12). The fields above keep their existing types and carry
   * the deterministic aggregate, so a consumer that never learned about cohorts
   * reads what it read before either way.
   */
  roundSeq: z.number().int().positive().nullable().optional(),
  specialists: z.array(graphWorkflowValidationSpecialistEntrySchema).optional(),
});
export type GraphWorkflowValidationResultEvent = z.infer<
  typeof graphWorkflowValidationResultEventSchema
>;

/**
 * One cohort member's verdict, published on its own as the round accepts it.
 *
 * Separate from the aggregate because the two answer different questions at
 * different times: this one says "this reviewer has reported" while the round
 * is still running, and the aggregate says "the round concluded". A surface
 * that wants live per-lane detail subscribes here; evidence ingestion, which
 * records concluded reviews, filters this out by type and never sees it.
 */
export const graphWorkflowValidationSpecialistResultEventSchema = z.object({
  type: z.literal("graph-workflow-validation-specialist-result"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  roundSeq: z.number().int().positive(),
  specialist: graphWorkflowValidationSpecialistEntrySchema,
});
export type GraphWorkflowValidationSpecialistResultEvent = z.infer<
  typeof graphWorkflowValidationSpecialistResultEventSchema
>;

/**
 * A validation round that ended without anyone judging the work.
 *
 * Deliberately a separate event type from `graph-workflow-validation-result`:
 * an infrastructure outcome is not a verdict, and a surface that renders the two
 * the same way would let "the tree moved" read as "the reviewer said no". A
 * consumer counting failures reads validation results; a consumer diagnosing a
 * stuck context reads these.
 */
export const graphWorkflowValidationIncidentEventSchema = z.object({
  type: z.literal("graph-workflow-validation-incident"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  /**
   * What happened that was not a verdict.
   *
   * Round-level: `candidate_mismatch` — the tree moved (or stopped being
   * readable) under the cohort; `roster_drift` — the cohort the definition now
   * declares is not the one the round froze.
   *
   * Lane-level: `infra_failure` — one admitted dispatch failed and the lane
   * retries against the unchanged candidate; `infra_exhausted` — a required
   * specialist spent every attempt on infrastructure failures, so the round has
   * no verdict from it and cannot conclude at all; `stale_result_rejected` — a
   * result came back carrying another round's token, so it judged a candidate
   * this round cannot vouch for; `round_superseded` — a lane answered into a
   * round record that is no longer the one it started in, so its write is
   * dropped rather than landing on a stranger's round.
   */
  incident: z.enum([
    "candidate_mismatch",
    "roster_drift",
    "infra_failure",
    "infra_exhausted",
    "stale_result_rejected",
    "round_superseded",
  ]),
  roundSeq: z.number().int().positive(),
  /** Which re-verification point caught it. */
  stage: z.enum([
    "post_script",
    "diff_render",
    "specialist_result",
    "aggregate",
  ]),
  /** The specialist whose result was rejected; null for round-level checks. */
  assignmentId: z.string().nullable().default(null),
  /**
   * Admitted dispatches the named specialist spent. Zero for every incident
   * except an exhaustion, and zero there too when the queue never admitted it.
   */
  attempts: z.number().int().min(0).default(0),
  /** What diverged: candidate components, or the drifted roster seats. */
  driftedComponents: z.string(),
  message: z.string(),
});
export type GraphWorkflowValidationIncidentEvent = z.infer<
  typeof graphWorkflowValidationIncidentEventSchema
>;

export const graphWorkflowCircuitBreakerEventSchema = z.object({
  type: z.literal("graph-workflow-circuit-breaker"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  condition: graphWorkflowCircuitBreakerConditionSchema,
  failureCount: z.number().int().min(0),
  summary: z.string().nullable().default(null),
});
export type GraphWorkflowCircuitBreakerEvent = z.infer<
  typeof graphWorkflowCircuitBreakerEventSchema
>;

export const graphWorkflowSharedDocumentsUpdatedEventSchema = z.object({
  type: z.literal("graph-workflow-shared-documents-updated"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  documents: z.array(graphWorkflowSharedDocumentEntrySchema),
});
export type GraphWorkflowSharedDocumentsUpdatedEvent = z.infer<
  typeof graphWorkflowSharedDocumentsUpdatedEventSchema
>;

export const graphWorkflowLaneStatusEventSchema = z.object({
  type: z.literal("graph-workflow-lane-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  laneId: graphWorkflowExecutionLaneIdSchema,
  kind: graphWorkflowExecutionLaneKindSchema,
  status: graphWorkflowExecutionLaneStatusSchema,
  branchName: z.string(),
  worktreePath: z.string().nullable(),
  includedContextIds: z.array(z.string()),
  lastCommittingContextId: z.string().nullable(),
});
export type GraphWorkflowLaneStatusEvent = z.infer<
  typeof graphWorkflowLaneStatusEventSchema
>;

export const graphWorkflowLaneCommitEventSchema = z.object({
  type: z.literal("graph-workflow-lane-commit"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  laneId: graphWorkflowExecutionLaneIdSchema,
  sha: z.string().trim().min(1),
  committedAt: z.string(),
});
export type GraphWorkflowLaneCommitEvent = z.infer<
  typeof graphWorkflowLaneCommitEventSchema
>;

export const graphWorkflowJoinStatusEventSchema = z.object({
  type: z.literal("graph-workflow-join-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  joinId: graphWorkflowExecutionJoinIdSchema,
  kind: graphWorkflowExecutionJoinKindSchema,
  contextId: z.string().nullable(),
  status: graphWorkflowExecutionJoinStatusSchema,
  sourceLaneIds: z.array(graphWorkflowExecutionLaneIdSchema),
  mergedSourceLaneIds: z.array(graphWorkflowExecutionLaneIdSchema),
  targetLaneId: graphWorkflowExecutionLaneIdSchema,
  errorMessage: z.string().nullable(),
  conflicts: graphWorkflowExecutionJoinConflictDetailSchema.nullable(),
});
export type GraphWorkflowJoinStatusEvent = z.infer<
  typeof graphWorkflowJoinStatusEventSchema
>;

export const graphWorkflowApprovalPendingEventSchema = z.object({
  type: z.literal("graph-workflow-approval-pending"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  contextTitle: z.string().nullable(),
  conversationId: z.string(),
  requestedAt: z.string(),
});
export type GraphWorkflowApprovalPendingEvent = z.infer<
  typeof graphWorkflowApprovalPendingEventSchema
>;

export const graphWorkflowApprovalResolvedEventSchema = z.object({
  type: z.literal("graph-workflow-approval-resolved"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  conversationId: z.string(),
  decision: z.enum(["approved", "rejected"]),
  message: z.string().nullable(),
  decidedAt: z.string(),
});
export type GraphWorkflowApprovalResolvedEvent = z.infer<
  typeof graphWorkflowApprovalResolvedEventSchema
>;

export const graphWorkflowUserInputPendingEventSchema = z.object({
  type: z.literal("graph-workflow-user-input-pending"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  contextTitle: z.string().nullable(),
  conversationId: z.string(),
  questionBatchId: z.string(),
  requestedAt: z.string(),
});
export type GraphWorkflowUserInputPendingEvent = z.infer<
  typeof graphWorkflowUserInputPendingEventSchema
>;

export const graphWorkflowUserInputResolvedEventSchema = z.object({
  type: z.literal("graph-workflow-user-input-resolved"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  conversationId: z.string(),
  questionBatchId: z.string(),
  resolution: z.enum(["answered", "withdrawn"]),
  resolvedAt: z.string(),
});
export type GraphWorkflowUserInputResolvedEvent = z.infer<
  typeof graphWorkflowUserInputResolvedEventSchema
>;

export const graphWorkflowCharterRegisteredEventSchema = z.object({
  type: z.literal("graph-workflow-charter-registered"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  definitionId: z.string(),
  definitionRevision: z.number().int().min(1),
  charterHash: z.string(),
});
export type GraphWorkflowCharterRegisteredEvent = z.infer<
  typeof graphWorkflowCharterRegisteredEventSchema
>;

export const graphWorkflowCharterUpdatedEventSchema = z.object({
  type: z.literal("graph-workflow-charter-updated"),
  projectName: z.string(),
  sessionName: z.string(),
  // A charter replacement may occur with no active execution (a
  // definition-level update), so the updated event carries a nullable
  // executionId — unlike the registered event, which is always seeded with one.
  executionId: z.string().nullable(),
  definitionId: z.string(),
  definitionRevision: z.number().int().min(1),
  charterHash: z.string(),
});
export type GraphWorkflowCharterUpdatedEvent = z.infer<
  typeof graphWorkflowCharterUpdatedEventSchema
>;

// Mandatory live-edit notification (doc 06, D12/D16). Unlike every other
// graph-workflow event, a live edit may be config-only or future-structure and
// so produce no status/diff event — this carries the `liveRevision` bump and
// the affected contexts so the UI invalidates and refetches. `source` records
// which entry point applied the batch; `lane-agent` is server-derived on the
// lane route only (never accepted on the runtime-edits endpoint, D15), and
// `plan-repair` is server-derived by the D1 repair supervisor
// (docs/design/cc-cli/08) — neither is client-claimable.
export const graphWorkflowLiveEditAppliedEventSchema = z.object({
  type: z.literal("graph-workflow-live-edit-applied"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  liveRevision: z.number().int().min(1),
  operationCount: z.number().int().min(1),
  affectedContextIds: z.array(z.string()),
  source: z.enum(["cli", "ui", "lane-agent", "plan-repair"]),
});
export type GraphWorkflowLiveEditAppliedEvent = z.infer<
  typeof graphWorkflowLiveEditAppliedEventSchema
>;

// One plan-repair round conclusion (docs/design/cc-cli/08) — emitted when a
// round settles (or repair is exhausted for the halt, outcome `exhausted`,
// which is event-only and never a round-log outcome). The audit trail for the
// inspector Events panel; pushes derive from it in the dispatcher.
export const graphWorkflowPlanRepairEventSchema = z.object({
  type: z.literal("graph-workflow-plan-repair"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  haltType: z.enum(["circuit_breaker", "max_iterations"]),
  attempt: z.number().int().min(0),
  outcome: z.enum([
    "repaired",
    "declined",
    "failed",
    "superseded",
    "exhausted",
  ]),
  planningDefect: z.boolean().nullable().default(null),
  diagnosis: z.string().nullable().default(null),
  operationCount: z.number().int().min(0).default(0),
  resumed: z.boolean().default(false),
  conversationId: z.string().nullable().default(null),
});
export type GraphWorkflowPlanRepairEvent = z.infer<
  typeof graphWorkflowPlanRepairEventSchema
>;

const graphWorkflowSseEventSchema = z.discriminatedUnion("type", [
  graphWorkflowStatusEventSchema,
  graphWorkflowContextStatusEventSchema,
  graphWorkflowTaskStatusEventSchema,
  graphWorkflowValidationResultEventSchema,
  graphWorkflowValidationSpecialistResultEventSchema,
  graphWorkflowValidationIncidentEventSchema,
  graphWorkflowCircuitBreakerEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowPendingHaltReasonEventSchema,
  graphWorkflowMergeStatusEventSchema,
  graphWorkflowBatchScheduledEventSchema,
  graphWorkflowLaneStatusEventSchema,
  graphWorkflowLaneCommitEventSchema,
  graphWorkflowJoinStatusEventSchema,
  graphWorkflowApprovalPendingEventSchema,
  graphWorkflowApprovalResolvedEventSchema,
  graphWorkflowUserInputPendingEventSchema,
  graphWorkflowUserInputResolvedEventSchema,
  graphWorkflowCharterRegisteredEventSchema,
  graphWorkflowCharterUpdatedEventSchema,
  graphWorkflowLiveEditAppliedEventSchema,
  graphWorkflowPlanRepairEventSchema,
]);
export type GraphWorkflowSSEEvent = z.infer<typeof graphWorkflowSseEventSchema>;

export const graphWorkflowExecutionEventSchema = z.object({
  occurredAt: z.string(),
  event: graphWorkflowSseEventSchema,
  preReset: z.boolean().default(false),
});
export type GraphWorkflowExecutionEvent = z.infer<
  typeof graphWorkflowExecutionEventSchema
>;

export const graphWorkflowExecutionEventsResponseSchema = z.object({
  events: z.array(graphWorkflowExecutionEventSchema),
});
export type GraphWorkflowExecutionEventsResponse = z.infer<
  typeof graphWorkflowExecutionEventsResponseSchema
>;
