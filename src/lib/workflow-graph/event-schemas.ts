import { z } from "zod";
import {
  agentBackendIdShapeSchema,
  type AgentBackendId,
} from "@/lib/shared/schemas";
import {
  graphWorkflowContextStatusSchema,
  graphWorkflowSharedDocumentEntrySchema,
  graphWorkflowStatusSchema,
  graphWorkflowTaskSourceSchema,
  graphWorkflowTaskStatusSchema,
  graphWorkflowValidatorTypeSchema,
  workflowValidatorIssueSchema,
} from "./definition-schemas";
import { graphWorkflowCircuitBreakerConditionSchema } from "./config-schemas";
import {
  graphWorkflowExecutionJoinConflictDetailSchema,
  graphWorkflowExecutionJoinKindSchema,
  graphWorkflowExecutionJoinStatusSchema,
  graphWorkflowHaltReasonSchema,
  graphWorkflowLaneKindSchema,
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

function normalizeLegacyValidationEventSessionRef(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) {
    if (record.lane !== undefined && record.refKind !== undefined) return value;
    return {
      ...record,
      lane: record.lane ?? "context_validator",
      refKind: record.refKind ?? "backend",
    };
  }

  if (record.engine === "claude") {
    return {
      backend: record.engine,
      ref: record.conversationId,
      lane: record.lane,
      refKind: "conversation",
      workflowConversationId: record.conversationId,
    };
  }
  if (record.engine === "codex") {
    return {
      backend: record.engine,
      ref: record.threadId,
      lane: record.lane,
      refKind: "backend",
    };
  }
  return value;
}

export const graphWorkflowValidationEventSessionRefSchema = z.preprocess(
  normalizeLegacyValidationEventSessionRef,
  z.object({
    backend: agentBackendIdShapeSchema,
    ref: z.string().trim().min(1),
    lane: graphWorkflowLaneKindSchema,
    refKind: z.enum(["conversation", "backend"]),
    workflowConversationId: z.string().trim().min(1).optional(),
  }),
);
export type GraphWorkflowValidationEventSessionRef = z.infer<
  typeof graphWorkflowValidationEventSessionRefSchema
>;

const graphWorkflowValidationReviewUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Estimated from token usage because providers do not report USD. */
  costUsd: z.number().nullable().default(null),
});

/**
 * Usage for conversation-strategy validators, derived from the conversation
 * transcript after the turn. Token counts are not projected from transcripts,
 * so this carries the billable figures the transcript does report — without
 * it every conversation-validator decision is unpriced in cost audits.
 */
const graphWorkflowValidationConversationUsageSchema = z.object({
  costUsd: z.number().nullable().default(null),
  apiTurns: z.number().int().min(0).nullable().default(null),
});
export type GraphWorkflowValidationConversationUsage = z.infer<
  typeof graphWorkflowValidationConversationUsageSchema
>;

function normalizeLegacyValidationReviewArtifact(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) return value;

  if (record.engine === "claude") {
    return {
      backend: record.engine,
      kind: "conversation",
      ref: record.conversationId,
    };
  }
  if (record.engine === "codex") {
    return {
      backend: record.engine,
      kind: "response",
      ref: record.threadId,
      response: record.response,
      usage: record.usage,
    };
  }
  return value;
}

export const graphWorkflowValidationReviewArtifactSchema = z.preprocess(
  normalizeLegacyValidationReviewArtifact,
  z.discriminatedUnion("kind", [
    z.object({
      backend: agentBackendIdShapeSchema,
      kind: z.literal("conversation"),
      ref: z.string().trim().min(1),
      usage: graphWorkflowValidationConversationUsageSchema
        .nullable()
        .default(null),
    }),
    z.object({
      backend: agentBackendIdShapeSchema,
      kind: z.literal("response"),
      ref: z.string().trim(),
      response: z.string(),
      usage: graphWorkflowValidationReviewUsageSchema.nullable().default(null),
    }),
  ]),
);
export type GraphWorkflowValidationReviewArtifact = z.infer<
  typeof graphWorkflowValidationReviewArtifactSchema
>;

export function buildGraphWorkflowValidationReviewArtifact(input: {
  backend: AgentBackendId;
  strategy: "conversation" | "task";
  ref: string | null;
  response: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  } | null;
  /** Transcript-derived usage for conversation-strategy validators. */
  conversationUsage?: GraphWorkflowValidationConversationUsage | null;
}): GraphWorkflowValidationReviewArtifact | null {
  if (input.ref === null) return null;
  if (input.strategy === "conversation") {
    return {
      backend: input.backend,
      kind: "conversation",
      ref: input.ref,
      usage: input.conversationUsage ?? null,
    };
  }
  return {
    backend: input.backend,
    kind: "response",
    ref: input.ref,
    response: input.response,
    usage: input.usage,
  };
}

export const graphWorkflowValidationResultEventSchema = z.object({
  type: z.literal("graph-workflow-validation-result"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  validatorType: graphWorkflowValidatorTypeSchema,
  pass: z.boolean(),
  summary: z.string(),
  reopenTaskIds: z.array(z.string().trim().min(1)).default([]),
  issues: z.array(workflowValidatorIssueSchema).default([]),
  sessionRef: graphWorkflowValidationEventSessionRefSchema
    .nullable()
    .optional(),
  reviewArtifact: graphWorkflowValidationReviewArtifactSchema
    .nullable()
    .optional(),
});
export type GraphWorkflowValidationResultEvent = z.infer<
  typeof graphWorkflowValidationResultEventSchema
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
// lane route only (never accepted on the runtime-edits endpoint, D15).
export const graphWorkflowLiveEditAppliedEventSchema = z.object({
  type: z.literal("graph-workflow-live-edit-applied"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  liveRevision: z.number().int().min(1),
  operationCount: z.number().int().min(1),
  affectedContextIds: z.array(z.string()),
  source: z.enum(["cli", "ui", "lane-agent"]),
});
export type GraphWorkflowLiveEditAppliedEvent = z.infer<
  typeof graphWorkflowLiveEditAppliedEventSchema
>;

const graphWorkflowSseEventSchema = z.discriminatedUnion("type", [
  graphWorkflowStatusEventSchema,
  graphWorkflowContextStatusEventSchema,
  graphWorkflowTaskStatusEventSchema,
  graphWorkflowValidationResultEventSchema,
  graphWorkflowCircuitBreakerEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
  graphWorkflowPendingHaltReasonEventSchema,
  graphWorkflowMergeStatusEventSchema,
  graphWorkflowBatchScheduledEventSchema,
  graphWorkflowLaneStatusEventSchema,
  graphWorkflowJoinStatusEventSchema,
  graphWorkflowApprovalPendingEventSchema,
  graphWorkflowApprovalResolvedEventSchema,
  graphWorkflowUserInputPendingEventSchema,
  graphWorkflowUserInputResolvedEventSchema,
  graphWorkflowCharterRegisteredEventSchema,
  graphWorkflowCharterUpdatedEventSchema,
  graphWorkflowLiveEditAppliedEventSchema,
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
