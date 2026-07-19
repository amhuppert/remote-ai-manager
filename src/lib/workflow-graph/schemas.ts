import { z } from "zod";
import {
  conflictDecisionInputSchema,
  conflictEntrySchema,
} from "@/lib/jobs/schemas";
import {
  askQuestionAnswerSchema,
  askQuestionItemSchema,
} from "@/lib/conversations/schemas";
import {
  agentBackendSchema,
  agentSessionRefSchema,
} from "@/lib/shared/schemas";
import {
  laneMetricsSchema,
  laneTurnUsageSchema,
} from "@/lib/workflows/primitives/lane-vocabulary";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import { graphWorkflowCircuitBreakerConditionSchema } from "./config-schemas";
import {
  graphWorkflowCollaborationContinuationSchema,
  graphWorkflowPendingCollaborationSchema,
} from "./collaboration-schemas";
import {
  graphWorkflowContextStatusSchema,
  graphWorkflowSharedDocumentEntrySchema,
  graphWorkflowStatusSchema,
  graphWorkflowTaskStatusSchema,
  resolvedWorkflowSemanticDefinitionSchema,
} from "./definition-schemas";

// ============================================================
// Graph Workflow Halt Reasons
// ============================================================

export const graphWorkflowHaltReasonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("circuit_breaker"),
    contextId: z.string().trim().min(1),
    condition: graphWorkflowCircuitBreakerConditionSchema,
    failureCount: z.number().int().min(0).optional(),
    summary: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("max_iterations"),
    contextId: z.string().trim().min(1),
    iterationCount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("recovery_error"),
    message: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("aborted"),
  }),
  z.object({
    type: z.literal("validator_infra_error"),
    contextId: z.string().trim().min(1),
    engine: agentBackendSchema,
    infraReason: z.enum(["exception", "unparseable", "schema_mismatch"]),
    message: z.string(),
    summary: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("script_validator_missing_command"),
    contextId: z.string().trim().min(1),
    message: z.string(),
  }),
  z.object({
    type: z.literal("merge_failure"),
    contextId: z.string().trim().min(1),
    message: z.string(),
    conflictFiles: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("join_failure"),
    joinId: z.string().trim().min(1),
    joinKind: z.enum(["context_merge", "final_publish"]),
    contextId: z.string().trim().min(1).nullable().default(null),
    sourceLaneIds: z.array(z.string().trim().min(1)).min(1),
    targetLaneId: z.string().trim().min(1),
    message: z.string(),
    conflictFiles: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("merge_precondition_failed"),
    contextId: z.string().trim().min(1),
    targetBranch: z.string().trim().min(1),
    dirtyPaths: z
      .array(
        z.object({
          path: z.string(),
          statusCode: z.string(),
          tracked: z.boolean(),
        }),
      )
      .max(5)
      .default([]),
    totalDirtyCount: z.number().int().min(0),
    message: z.string(),
  }),
  z.object({
    type: z.literal("agent_turn_failed"),
    contextId: z.string().trim().min(1),
    engine: agentBackendSchema,
    cause: z.enum(["sdk_error", "abort", "timeout", "stall", "unknown"]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("worktree_creation_dirty"),
    contextId: z.string().trim().min(1).nullable().default(null),
    worktreePath: z.string().trim().min(1),
    branchName: z.string().trim().min(1),
    dirtyPaths: z
      .array(
        z.object({
          path: z.string(),
          statusCode: z.string(),
          tracked: z.boolean(),
        }),
      )
      .max(5)
      .default([]),
    totalDirtyCount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("execution_loop_failed"),
    contextId: z.string().trim().min(1).nullable().default(null),
    message: z.string(),
    cause: z.enum(["sdk_error", "validation", "io", "unknown"]),
  }),
  z.object({
    type: z.literal("collaboration_failure"),
    status: z.enum([
      "converged",
      "rounds_exhausted",
      "requires_user_input",
      "objective_disagreement",
    ]),
    brief: z.string().trim().min(1),
    executionContextId: z.string().trim().min(1),
    conversationId: z.string().trim().min(1),
    summary: z.string().trim().min(1),
  }),
]);
export type GraphWorkflowHaltReason = z.infer<
  typeof graphWorkflowHaltReasonSchema
>;

// ============================================================
// Graph Workflow Lanes
// ============================================================

const graphWorkflowExecutionLaneIdSchema = z.string().trim().min(1);

const graphWorkflowExecutionLaneKindSchema = z.enum(["session", "worktree"]);

const graphWorkflowExecutionLaneStatusSchema = z.enum([
  "pending",
  "active",
  "merged",
  "halted",
]);

// Append-only audit/recovery record of commits on a lane. Git remains the
// authoritative source for the lane's current HEAD; these snapshots exist to
// reconstruct lane history and to support recovery after crashes.
const graphWorkflowExecutionLaneCommitSnapshotSchema = z.object({
  contextId: z.string().trim().min(1),
  sha: z.string().trim().min(1),
  committedAt: z.string(),
});
export type GraphWorkflowExecutionLaneCommitSnapshot = z.infer<
  typeof graphWorkflowExecutionLaneCommitSnapshotSchema
>;

export const graphWorkflowExecutionLaneStateSchema = z.object({
  laneId: graphWorkflowExecutionLaneIdSchema,
  kind: graphWorkflowExecutionLaneKindSchema,
  status: graphWorkflowExecutionLaneStatusSchema,
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().trim().min(1),
  includedContextIds: z.array(z.string().trim().min(1)).default([]),
  lastCommittingContextId: z.string().trim().min(1).nullable().default(null),
  commitSnapshots: z
    .array(graphWorkflowExecutionLaneCommitSnapshotSchema)
    .default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GraphWorkflowExecutionLaneState = z.infer<
  typeof graphWorkflowExecutionLaneStateSchema
>;

// ============================================================
// Graph Workflow Joins
// ============================================================

const graphWorkflowExecutionJoinIdSchema = z.string().trim().min(1);
export const graphWorkflowExecutionJoinKindSchema = z.enum([
  "context_merge",
  "final_publish",
]);
export type GraphWorkflowExecutionJoinKind = z.infer<
  typeof graphWorkflowExecutionJoinKindSchema
>;

export const graphWorkflowExecutionJoinStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "conflicts",
]);
export type GraphWorkflowExecutionJoinStatus = z.infer<
  typeof graphWorkflowExecutionJoinStatusSchema
>;

export const graphWorkflowExecutionJoinConflictDetailSchema = z.object({
  files: z.array(z.string().trim().min(1)).default([]),
  message: z.string().nullable().default(null),
  // Per-file conflict analysis from the merge machine's resolver, persisted so
  // a join_failure halt can show the operator what conflicted and why the
  // automatic resolution failed, not just a file list.
  analysis: z.array(conflictEntrySchema).nullable().default(null),
});
export type GraphWorkflowExecutionJoinConflictDetail = z.infer<
  typeof graphWorkflowExecutionJoinConflictDetailSchema
>;
export const graphWorkflowExecutionJoinStateSchema = z.object({
  joinId: graphWorkflowExecutionJoinIdSchema,
  kind: graphWorkflowExecutionJoinKindSchema,
  // context_merge joins are anchored to the joining context. final_publish joins
  // orchestrate the workflow-wide publish and are not tied to a single context.
  contextId: z.string().trim().min(1).nullable().default(null),
  targetLaneId: graphWorkflowExecutionLaneIdSchema,
  sourceLaneIds: z.array(graphWorkflowExecutionLaneIdSchema).min(1),
  // Per-source progress for resume-safety. Each merged source lane is appended
  // here after the merge runner reports success (including no-op merges). The
  // runner skips lanes already present here on resume.
  mergedSourceLaneIds: z.array(graphWorkflowExecutionLaneIdSchema).default([]),
  status: graphWorkflowExecutionJoinStatusSchema,
  errorMessage: z.string().nullable().default(null),
  conflicts: graphWorkflowExecutionJoinConflictDetailSchema
    .nullable()
    .default(null),
  // Operator guidance attached when a failed join is reset for retry; consumed
  // as per-file decisions by the next conflict-resolution attempt and cleared
  // when the join concludes.
  conflictGuidance: z
    .array(conflictDecisionInputSchema)
    .nullable()
    .default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().default(null),
});
export type GraphWorkflowExecutionJoinState = z.infer<
  typeof graphWorkflowExecutionJoinStateSchema
>;

// ============================================================
// Graph Workflow Approvals + User Input
// ============================================================

export const graphWorkflowApprovalDecisionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("approved"), decidedAt: z.string() }),
    z.object({
      type: z.literal("rejected"),
      message: z.string().trim().min(1),
      decidedAt: z.string(),
    }),
  ],
);
export type GraphWorkflowApprovalDecision = z.infer<
  typeof graphWorkflowApprovalDecisionSchema
>;

export const graphWorkflowPendingApprovalSchema = z.object({
  conversationId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
  decision: graphWorkflowApprovalDecisionSchema.nullable().default(null),
});
export type GraphWorkflowPendingApproval = z.infer<
  typeof graphWorkflowPendingApprovalSchema
>;

// Answers recorded for a parked user-input question batch. The answer
// primitives are reused from the conversation domain (never duplicated).
export const graphWorkflowUserInputAnswersSchema = z.object({
  byQuestionId: z.record(z.string(), askQuestionAnswerSchema),
  answeredAt: z.string().trim().min(1),
});
export type GraphWorkflowUserInputAnswers = z.infer<
  typeof graphWorkflowUserInputAnswersSchema
>;

// The parked-question record on a context awaiting user input. `questions` is a
// snapshot copied from the lane conversation at park time so the graph UI and
// the resume prompt are self-sufficient; `answers` is null until the operator
// answers (or is set pre-park for a fast answer).
export const graphWorkflowPendingUserInputSchema = z.object({
  conversationId: z.string().trim().min(1),
  lane: z.enum(["implementer", "context_validator"]),
  questionBatchId: z.string().trim().min(1),
  questions: z.array(askQuestionItemSchema),
  requestedAt: z.string().trim().min(1),
  answers: graphWorkflowUserInputAnswersSchema.nullable().default(null),
});
export type GraphWorkflowPendingUserInput = z.infer<
  typeof graphWorkflowPendingUserInputSchema
>;

// ============================================================
// Graph Workflow Context + Task State
// ============================================================

export const graphWorkflowExecutionContextStateSchema = z.object({
  contextId: z.string().trim().min(1),
  status: graphWorkflowContextStatusSchema,
  totalTaskCount: z.number().int().min(0),
  completedTaskCount: z.number().int().min(0).default(0),
  iterationCount: z.number().int().min(0).default(0),
  consecutiveFailureCount: z.number().int().min(0).default(0),
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().nullable().default(null),
  isolation: z.enum(["session", "worktree"]).default("session"),
  batchId: z.string().nullable().default(null),
  laneId: graphWorkflowExecutionLaneIdSchema.nullable().default(null),
  joinId: graphWorkflowExecutionJoinIdSchema.nullable().default(null),
  mergeStatus: z
    .enum([
      "not-applicable",
      "pending",
      "in-progress",
      "merged-success",
      "merged-failed",
      "conflicts",
    ])
    .default("not-applicable"),
  cleanupStatus: z
    .enum(["not-applicable", "pending", "removed", "failed"])
    .default("not-applicable"),
  lastMergeError: z.string().nullable().default(null),
  pendingApproval: graphWorkflowPendingApprovalSchema.nullable().default(null),
  pendingUserInput: graphWorkflowPendingUserInputSchema
    .nullable()
    .default(null),
});
export type GraphWorkflowExecutionContextState = z.infer<
  typeof graphWorkflowExecutionContextStateSchema
>;

const graphWorkflowTaskValidationFailureSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});
export type GraphWorkflowTaskValidationFailure = z.infer<
  typeof graphWorkflowTaskValidationFailureSchema
>;
const graphWorkflowTaskStateSchema = z.object({
  taskId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  order: z.number().int().min(1),
  status: graphWorkflowTaskStatusSchema,
  summary: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  lastConversationId: z.string().nullable().default(null),
  failureMessage: z.string().nullable().default(null),
  failureHistory: z.array(graphWorkflowTaskValidationFailureSchema).default([]),
});
export type GraphWorkflowTaskState = z.infer<
  typeof graphWorkflowTaskStateSchema
>;

// ============================================================
// Graph Workflow Session Refs + Agent Session State
// ============================================================

export const graphWorkflowLaneKindSchema = z.enum([
  "implementer",
  "context_validator",
]);
export type GraphWorkflowLaneKind = z.infer<typeof graphWorkflowLaneKindSchema>;

function normalizeLegacyGraphSessionRef(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) return value;
  if (record.engine === "claude") {
    return { backend: record.engine, ref: record.conversationId };
  }
  if (record.engine === "codex") {
    return { backend: record.engine, ref: record.threadId };
  }
  return value;
}

export const graphWorkflowExecutionSessionRefSchema = z.preprocess(
  normalizeLegacyGraphSessionRef,
  agentSessionRefSchema,
);
export type GraphWorkflowExecutionSessionRef = z.infer<
  typeof graphWorkflowExecutionSessionRefSchema
>;

export type GraphWorkflowAgentSessionTurnUsage = z.infer<
  typeof laneTurnUsageSchema
>;

function optionalMetric(
  record: Record<string, unknown>,
  legacyKey: string,
): Record<string, unknown> {
  const value = record[legacyKey];
  return value === null || value === undefined ? {} : { value };
}

function normalizeLegacyGraphLane(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) return value;
  if (record.engine !== "claude" && record.engine !== "codex") return value;

  const contextTokens = optionalMetric(record, "lastContextTokens").value;
  const contextWindowMax = optionalMetric(record, "lastContextWindowMax").value;
  const lastTurnUsage = optionalMetric(record, "lastTurnUsage").value;
  const normalizedSessionRef =
    record.sessionRef !== undefined
      ? normalizeLegacyGraphSessionRef(record.sessionRef)
      : undefined;
  const legacyConversationId =
    record.engine === "claude" &&
    typeof normalizedSessionRef === "object" &&
    normalizedSessionRef !== null
      ? (normalizedSessionRef as Record<string, unknown>).ref
      : undefined;

  return {
    backend: record.engine,
    refKind: record.engine === "claude" ? "conversation" : "backend",
    lane: record.lane,
    contextId: record.contextId,
    ...(record.workflowConversationId !== undefined ||
    legacyConversationId !== undefined
      ? {
          workflowConversationId:
            record.workflowConversationId ?? legacyConversationId,
        }
      : {}),
    ...(normalizedSessionRef !== undefined
      ? { sessionRef: normalizedSessionRef }
      : {}),
    metrics: {
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(contextWindowMax !== undefined ? { contextWindowMax } : {}),
      ...(lastTurnUsage !== undefined ? { lastTurnUsage } : {}),
      rotateBeforeNextTurn: record.rotateBeforeNextTurn ?? false,
    },
    limitEvaluation: record.limitEvaluation,
    lastUsedAt: record.lastUsedAt,
  };
}

export const graphWorkflowAgentSessionStateSchema = z.preprocess(
  normalizeLegacyGraphLane,
  z.object({
    lane: graphWorkflowLaneKindSchema,
    contextId: z.string().trim().min(1),
    backend: agentBackendSchema,
    refKind: z.enum(["conversation", "backend"]),
    workflowConversationId: z.string().trim().min(1).optional(),
    sessionRef: graphWorkflowExecutionSessionRefSchema.optional(),
    metrics: laneMetricsSchema,
    limitEvaluation: z.enum([
      "disabled",
      "supported",
      "unsupported",
      "metrics_unavailable",
    ]),
    lastUsedAt: z.string(),
  }),
);
export type GraphWorkflowAgentSessionState = z.infer<
  typeof graphWorkflowAgentSessionStateSchema
>;

// ============================================================
// Graph Workflow Execution (root runtime record)
// ============================================================

// Advisory lane plan computed at execution seed time. Persists the
// deterministic continuation choice the scheduler should make at each
// fan-out point so restarts make the same call. See
// `src/lib/workflow-graph/lane-plan.ts`.
const graphWorkflowLanePlanSchema = z.object({
  continuationMap: z.record(z.string(), z.string()).default({}),
  longestDownstreamPath: z
    .record(z.string(), z.number().int().min(0))
    .default({}),
});

export const graphWorkflowExecutionSchema = z.object({
  id: z.string().trim().min(1),
  seedDefinitionId: z.string().trim().min(1),
  seedDefinitionRevision: z.number().int().min(1),
  // Optimistic-concurrency token for live edits (doc 06, D4). A bounded scalar
  // counter incremented ONLY by accepted live-edit batches (including the
  // lane-agent `add_task`), never by scheduler ticks, so `baseLiveRevision`
  // guards catch edit-vs-edit lost updates. Persisted in the runtime tier
  // (`RUNTIME_TIER_KEYS`); rows written before the field existed parse as `1`.
  liveRevision: z.number().int().min(1).default(1),
  // Loop-generation fence token. Incremented ONLY by `resume()` — every resume
  // starts a new loop generation, and any execution loop still alive from a
  // prior generation (a "zombie" blocked in a long await across the
  // halt/resume) fails its fence check on the next read or write instead of
  // racing the new loop. Persisted in the runtime tier; rows written before
  // the field existed parse as `0`.
  loopEpoch: z.number().int().min(0).default(0),
  // Raw bound-input snapshot recording which parameter values produced the run.
  // All supported parameter types (string/text/enum) bind to string values, so
  // the value type is `string`. `.default({})` lets legacy execution rows that
  // predate parameter support parse back as zero-input audit shape (R6.5, R10.2).
  boundInputs: z.record(z.string(), z.string()).default({}),
  // Additive audit annotation recording the tier the template was launched
  // from. `.default("project")` lets legacy execution rows that predate the
  // global tier parse back as project-tier launches (R3.3, R9.3).
  launchedTier: z.enum(["project", "global"]).default("project"),
  workingDefinition: resolvedWorkflowSemanticDefinitionSchema,
  charter: workflowCharterSchema,
  status: graphWorkflowStatusSchema,
  activeContextIds: z.array(z.string()).default([]),
  contextStates: z
    .record(z.string(), graphWorkflowExecutionContextStateSchema)
    .default({}),
  taskStates: z.record(z.string(), graphWorkflowTaskStateSchema).default({}),
  sharedDocuments: z.array(graphWorkflowSharedDocumentEntrySchema).default([]),
  laneStates: z
    .record(
      z.string(),
      z.record(z.string(), graphWorkflowAgentSessionStateSchema),
    )
    .default({}),
  executionLanes: z
    .record(z.string(), graphWorkflowExecutionLaneStateSchema)
    .default({}),
  joins: z
    .record(z.string(), graphWorkflowExecutionJoinStateSchema)
    .default({}),
  lanePlan: graphWorkflowLanePlanSchema.default({
    continuationMap: {},
    longestDownstreamPath: {},
  }),
  machineSnapshot: z.unknown().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  secondaryHaltReasons: z.array(graphWorkflowHaltReasonSchema).default([]),
  pendingCollaborations: z
    .record(z.string(), graphWorkflowPendingCollaborationSchema)
    .default({}),
  collaborationContinuations: z
    .record(z.string(), z.array(graphWorkflowCollaborationContinuationSchema))
    .default({}),
  pendingMergeRetry: z.array(z.string().trim().min(1)).default([]),
});
export type GraphWorkflowExecution = z.infer<
  typeof graphWorkflowExecutionSchema
>;

export const graphWorkflowExecutionFullResponseSchema = z.object({
  execution: graphWorkflowExecutionSchema.nullable(),
});

export type GraphWorkflowExecutionFullResponse = z.infer<
  typeof graphWorkflowExecutionFullResponseSchema
>;

export const resetExecutionContextRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
});
