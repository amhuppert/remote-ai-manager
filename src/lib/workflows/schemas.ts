import { z } from "zod";
import {
  claudeModelSchema,
  codexModelSchema,
  codexReasoningEffortSchema,
  effortLevelSchema,
} from "@/lib/agent-backends/schemas";

// ============================================================
// Graph Workflow Agent Configuration Schemas
// ============================================================

const graphWorkflowClaudeAgentConfigSchema = z.object({
  backend: z.literal("claude"),
  model: claudeModelSchema,
  reasoningEffort: effortLevelSchema,
});

const graphWorkflowCodexAgentConfigSchema = z.object({
  backend: z.literal("codex"),
  model: codexModelSchema,
  reasoningEffort: codexReasoningEffortSchema,
});

export const graphWorkflowAgentConfigSchema = z.preprocess(
  (val) => {
    if (typeof val === "object" && val !== null && !("backend" in val)) {
      return { ...val, backend: "claude" };
    }
    return val;
  },
  z.discriminatedUnion("backend", [
    graphWorkflowClaudeAgentConfigSchema,
    graphWorkflowCodexAgentConfigSchema,
  ]),
);
export type GraphWorkflowAgentConfig = z.infer<
  typeof graphWorkflowAgentConfigSchema
>;

export const graphWorkflowMutabilityPolicySchema = z.object({
  allowAgentTaskAdd: z.boolean().default(false),
});
export type GraphWorkflowMutabilityPolicy = z.infer<
  typeof graphWorkflowMutabilityPolicySchema
>;

export const graphWorkflowCircuitBreakerPolicySchema = z.object({
  consecutiveFailureThreshold: z.number().int().min(1).optional(),
});
export type GraphWorkflowCircuitBreakerPolicy = z.infer<
  typeof graphWorkflowCircuitBreakerPolicySchema
>;

export const graphWorkflowLaneContinuityPolicySchema = z.object({
  enabled: z.boolean().default(true),
  contextLimitTokens: z.number().int().positive().optional(),
});
export const graphWorkflowIterationPolicySchema = z.object({
  maxIterations: z.number().int().min(1),
  continuity: graphWorkflowLaneContinuityPolicySchema.default({
    enabled: true,
  }),
});
export type GraphWorkflowIterationPolicy = z.infer<
  typeof graphWorkflowIterationPolicySchema
>;

const graphWorkflowValidatorBaseSchema = z.object({
  enabled: z.boolean().default(true),
  continuity: graphWorkflowLaneContinuityPolicySchema.default({
    enabled: true,
  }),
});

const graphWorkflowClaudeValidatorConfigSchema =
  graphWorkflowValidatorBaseSchema.extend({
    type: z.literal("claude"),
    agent: graphWorkflowAgentConfigSchema,
  });

const graphWorkflowCodexValidatorConfigSchema =
  graphWorkflowValidatorBaseSchema.extend({
    type: z.literal("codex"),
    codex: z
      .object({
        model: codexModelSchema.optional(),
        reasoningEffort: codexReasoningEffortSchema.optional(),
      })
      .default({}),
  });

export const graphWorkflowAgentValidatorConfigSchema = z.discriminatedUnion(
  "type",
  [
    graphWorkflowClaudeValidatorConfigSchema,
    graphWorkflowCodexValidatorConfigSchema,
  ],
);
export type GraphWorkflowAgentValidatorConfig = z.infer<
  typeof graphWorkflowAgentValidatorConfigSchema
>;
export const graphWorkflowScriptValidatorConfigSchema = z.object({
  enabled: z.boolean().default(false),
});
export type GraphWorkflowScriptValidatorConfig = z.infer<
  typeof graphWorkflowScriptValidatorConfigSchema
>;

export const contextValidatorOverrideSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("use"),
    value: graphWorkflowAgentValidatorConfigSchema,
  }),
  z.object({ kind: z.literal("disabled") }),
]);
export type ContextValidatorOverride = z.infer<
  typeof contextValidatorOverrideSchema
>;

const graphWorkflowCircuitBreakerConditionSchema = z.enum(["retry_exhaustion"]);

// ============================================================
// Collaboration severity / category / threshold primitives
// ============================================================
// Hoisted above the collaboration config block so the latter can compose
// `collaborationAutonomousResolutionThresholdSchema`. Full collaboration
// artifact schemas (initial_draft, cross_review, etc.) remain below in the
// "Collaboration Mode — asymmetric artifact contract" section.
const collaborationDisagreementSeveritySchema = z.enum([
  "minor",
  "major",
  "blocking",
]);
export type CollaborationDisagreementSeverity = z.infer<
  typeof collaborationDisagreementSeveritySchema
>;

const collaborationFlowAgentSchema = z.enum(["agent_one", "agent_two"]);
export type CollaborationFlowAgent = z.infer<
  typeof collaborationFlowAgentSchema
>;

const collaborationDisagreementCategorySchema = z.enum([
  "objective",
  "implementation",
]);
export type CollaborationDisagreementCategory = z.infer<
  typeof collaborationDisagreementCategorySchema
>;

export const collaborationAutonomousResolutionThresholdSchema = z.enum([
  "none",
  "minor",
  "major",
  "blocking",
]);
export type CollaborationAutonomousResolutionThreshold = z.infer<
  typeof collaborationAutonomousResolutionThresholdSchema
>;

// ============================================================
// Agent-Invoked Collaboration Config
// ============================================================
// Composed into:
//   - workflowDefaultsSchema (src/lib/config/schemas.ts) — required on parsed,
//     optional on raw twin; loader seeds the default when absent.
//   - workflowConfigOverrideSchema (this file) — optional override.
//   - graphWorkflowExecutionContextDefinitionSchema (this file) — optional
//     per-context override.
// Resolved (with per-field provenance) by
// `resolveCollaborationConfigWithProvenance` in
// `src/lib/workflow-graph/resolve-config.ts`.
export const workflowCollaborationConfigSchema = z.object({
  secondAgent: graphWorkflowAgentConfigSchema,
  negotiationRounds: z.number().int().positive(),
  autonomousResolutionThreshold:
    collaborationAutonomousResolutionThresholdSchema,
});
export type WorkflowCollaborationConfig = z.infer<
  typeof workflowCollaborationConfigSchema
>;

// Override block at the workflow-level and per-context layers. Each field is
// individually optional so the cascade can compute provenance per-field,
// satisfying R2.1–R2.3 and the "no `??` across the block" invariant in
// `resolveCollaborationConfigWithProvenance`.
export const workflowCollaborationConfigOverrideSchema = z.object({
  secondAgent: graphWorkflowAgentConfigSchema.optional(),
  negotiationRounds: z.number().int().positive().optional(),
  autonomousResolutionThreshold:
    collaborationAutonomousResolutionThresholdSchema.optional(),
});
export type WorkflowCollaborationConfigOverride = z.infer<
  typeof workflowCollaborationConfigOverrideSchema
>;

export const collaborationConfigSourceSchema = z.enum([
  "per-node",
  "workflow",
  "global",
]);
export type CollaborationConfigSource = z.infer<
  typeof collaborationConfigSourceSchema
>;

const provenancedField = <T extends z.ZodTypeAny>(value: T) =>
  z.object({
    value,
    source: collaborationConfigSourceSchema,
  });

export const resolvedCollaborationConfigSchema = z.object({
  secondAgent: provenancedField(graphWorkflowAgentConfigSchema),
  negotiationRounds: provenancedField(z.number().int().positive()),
  autonomousResolutionThreshold: provenancedField(
    collaborationAutonomousResolutionThresholdSchema,
  ),
});
export type ResolvedCollaborationConfig = z.infer<
  typeof resolvedCollaborationConfigSchema
>;

export const workflowConfigOverrideSchema = z.object({
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: graphWorkflowAgentValidatorConfigSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  collaboration: workflowCollaborationConfigOverrideSchema.optional(),
});
export type WorkflowConfigOverride = z.infer<
  typeof workflowConfigOverrideSchema
>;

// ============================================================
// Graph Workflow Semantic Definition + Execution Context
// ============================================================

export const graphWorkflowExecutionContextDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    z.string().trim().min(1).optional(),
  ),
  acceptanceCriteria: z.string().trim().min(1),
  implementer: graphWorkflowAgentConfigSchema.optional(),
  contextValidator: contextValidatorOverrideSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  collaboration: workflowCollaborationConfigOverrideSchema.optional(),
});
export type GraphWorkflowExecutionContextDefinition = z.infer<
  typeof graphWorkflowExecutionContextDefinitionSchema
>;

const graphWorkflowTaskSourceSchema = z.enum(["user", "agent"]);
const graphWorkflowTaskDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  order: z.number().int().min(1),
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  source: graphWorkflowTaskSourceSchema.default("user"),
});
export type GraphWorkflowTaskDefinition = z.infer<
  typeof graphWorkflowTaskDefinitionSchema
>;

const graphWorkflowContextEdgeSchema = z.object({
  id: z.string().trim().min(1),
  sourceContextId: z.string().trim().min(1),
  targetContextId: z.string().trim().min(1),
});
export type GraphWorkflowContextEdge = z.infer<
  typeof graphWorkflowContextEdgeSchema
>;

export const workflowSemanticDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  workflowConfig: workflowConfigOverrideSchema.default({}),
  executionContexts: z
    .array(graphWorkflowExecutionContextDefinitionSchema)
    .default([]),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
});
export type WorkflowSemanticDefinition = z.infer<
  typeof workflowSemanticDefinitionSchema
>;

export const graphWorkflowResolvedContextSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.string().trim().min(1),
  implementer: graphWorkflowAgentConfigSchema,
  contextValidator: graphWorkflowAgentValidatorConfigSchema.nullable(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.default({
    enabled: false,
  }),
  mutability: graphWorkflowMutabilityPolicySchema,
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema,
  iterationPolicy: graphWorkflowIterationPolicySchema,
});
export type GraphWorkflowResolvedContext = z.infer<
  typeof graphWorkflowResolvedContextSchema
>;

export const resolvedWorkflowSemanticDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  executionContexts: z.array(graphWorkflowResolvedContextSchema).default([]),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
});
export type ResolvedWorkflowSemanticDefinition = z.infer<
  typeof resolvedWorkflowSemanticDefinitionSchema
>;

const graphWorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const graphWorkflowViewportSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  zoom: z.number().positive().default(1),
});

export const graphWorkflowVisualLayoutSchema = z.object({
  workflowId: z.string().trim().min(1),
  contextPositions: z
    .record(z.string(), graphWorkflowPositionSchema)
    .default({}),
  viewport: graphWorkflowViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
});
export type GraphWorkflowVisualLayout = z.infer<
  typeof graphWorkflowVisualLayoutSchema
>;

export const workflowDefinitionRecordSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().default(null),
  schemaVersion: z.number().int().positive().default(1),
  revision: z.number().int().min(1),
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowDefinitionRecord = z.infer<
  typeof workflowDefinitionRecordSchema
>;

const workflowValidatorIssueSchema = z.object({
  taskId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
});
export type WorkflowValidatorIssue = z.infer<
  typeof workflowValidatorIssueSchema
>;

export const workflowAgentValidatorResultSchema = z.object({
  summary: z.string(),
  issues: z.array(workflowValidatorIssueSchema).default([]),
});

const graphWorkflowSharedDocumentEntrySchema = z.object({
  id: z.string().trim().min(1),
  relativePath: z.string().trim().min(1),
  description: z.string().trim().min(1),
  readWhen: z.string().trim().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUpdatedByConversationId: z.string().nullable().default(null),
});
export type GraphWorkflowSharedDocumentEntry = z.infer<
  typeof graphWorkflowSharedDocumentEntrySchema
>;

const graphWorkflowStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "completed",
  "halted",
  "aborted",
]);
export type GraphWorkflowStatus = z.infer<typeof graphWorkflowStatusSchema>;

export const graphWorkflowContextStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "halted",
]);
export type GraphWorkflowContextStatus = z.infer<
  typeof graphWorkflowContextStatusSchema
>;

const graphWorkflowTaskStatusSchema = z.enum([
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
]);
export type GraphWorkflowTaskStatus = z.infer<
  typeof graphWorkflowTaskStatusSchema
>;

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
    engine: z.enum(["claude", "codex"]),
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
    engine: z.enum(["claude", "codex"]),
    cause: z.enum(["sdk_error", "abort", "unknown"]),
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
// Workflow Collaboration Result
// ============================================================
// The structured value returned by the workflow-scoped collaboration envelope
// (and surfaced to the implementer agent via `request_collaboration`). The
// four-value status mirrors the agent-facing branches of the collaboration
// policy mapping table (research.md §10.1); the result-level `superRefine`
// enforces the invariants the policy expresses informally:
//   - converged outcomes MUST carry a non-empty `finalAnswer`
//   - any non-converged outcome MUST carry at least one open conflict so the
//     surfaced failure record is never structurally empty.
export const workflowCollaborationStatusSchema = z.enum([
  "converged",
  "rounds_exhausted",
  "requires_user_input",
  "objective_disagreement",
]);
export type WorkflowCollaborationStatus = z.infer<
  typeof workflowCollaborationStatusSchema
>;

const workflowCollaborationOpenConflictSchema = z.object({
  rejectingAgent: collaborationFlowAgentSchema,
  disputedPoint: z.string().trim().min(1),
  severity: collaborationDisagreementSeveritySchema,
  category: collaborationDisagreementCategorySchema,
});
export type WorkflowCollaborationOpenConflict = z.infer<
  typeof workflowCollaborationOpenConflictSchema
>;

export const workflowCollaborationResultSchema = z
  .object({
    status: workflowCollaborationStatusSchema,
    finalAnswer: z.string().min(1).nullable(),
    openConflicts: z.array(workflowCollaborationOpenConflictSchema).default([]),
  })
  .superRefine((result, ctx) => {
    if (result.status === "converged" && result.finalAnswer == null) {
      ctx.addIssue({
        code: "custom",
        message: "converged result must include a non-empty finalAnswer",
        path: ["finalAnswer"],
      });
    }
    if (result.status !== "converged" && result.openConflicts.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "non-converged result must populate at least one openConflict",
        path: ["openConflicts"],
      });
    }
  });
export type WorkflowCollaborationResult = z.infer<
  typeof workflowCollaborationResultSchema
>;

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

const graphWorkflowExecutionJoinConflictDetailSchema = z.object({
  files: z.array(z.string().trim().min(1)).default([]),
  message: z.string().nullable().default(null),
});
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
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().default(null),
});
export type GraphWorkflowExecutionJoinState = z.infer<
  typeof graphWorkflowExecutionJoinStateSchema
>;

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
});
export type GraphWorkflowExecutionContextState = z.infer<
  typeof graphWorkflowExecutionContextStateSchema
>;

const graphWorkflowTaskValidationFailureSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});
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

const graphWorkflowValidatorTypeSchema = z.enum(["context"]);
export type GraphWorkflowValidatorType = z.infer<
  typeof graphWorkflowValidatorTypeSchema
>;

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

const graphWorkflowLaneKindSchema = z.enum([
  "implementer",
  "context_validator",
]);
export type GraphWorkflowLaneKind = z.infer<typeof graphWorkflowLaneKindSchema>;

export const graphWorkflowExecutionSessionRefSchema = z.discriminatedUnion(
  "engine",
  [
    z.object({
      engine: z.literal("claude"),
      lane: graphWorkflowLaneKindSchema,
      conversationId: z.string().trim().min(1),
    }),
    z.object({
      engine: z.literal("codex"),
      lane: graphWorkflowLaneKindSchema,
      threadId: z.string().trim().min(1),
    }),
  ],
);
export type GraphWorkflowExecutionSessionRef = z.infer<
  typeof graphWorkflowExecutionSessionRefSchema
>;

const graphWorkflowValidationReviewArtifactSchema = z.discriminatedUnion(
  "engine",
  [
    z.object({
      engine: z.literal("claude"),
      conversationId: z.string().trim().min(1),
    }),
    z.object({
      engine: z.literal("codex"),
      threadId: z.string().trim(),
      response: z.string(),
      usage: z
        .object({
          inputTokens: z.number().int().min(0),
          cachedInputTokens: z.number().int().min(0),
          outputTokens: z.number().int().min(0),
        })
        .nullable()
        .default(null),
    }),
  ],
);
export type GraphWorkflowValidationReviewArtifact = z.infer<
  typeof graphWorkflowValidationReviewArtifactSchema
>;

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
  sessionRef: graphWorkflowExecutionSessionRefSchema.nullable().optional(),
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

export const resetExecutionContextRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
});

// ============================================================
// Agent-Session Runtime State
// ============================================================

const graphWorkflowAgentSessionTurnUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});
export type GraphWorkflowAgentSessionTurnUsage = z.infer<
  typeof graphWorkflowAgentSessionTurnUsageSchema
>;

export const graphWorkflowAgentSessionStateSchema = z.discriminatedUnion(
  "engine",
  [
    z.object({
      lane: graphWorkflowLaneKindSchema,
      contextId: z.string().trim().min(1),
      engine: z.literal("claude"),
      workflowConversationId: z.string().trim().min(1).optional(),
      sessionRef: graphWorkflowExecutionSessionRefSchema,
      lastContextTokens: z.number().int().nullable().default(null),
      lastContextWindowMax: z.number().int().nullable().default(null),
      rotateBeforeNextTurn: z.boolean().default(false),
      limitEvaluation: z.enum(["disabled", "supported"]),
      lastUsedAt: z.string(),
    }),
    z.object({
      lane: graphWorkflowLaneKindSchema,
      contextId: z.string().trim().min(1),
      engine: z.literal("codex"),
      workflowConversationId: z.string().trim().min(1).optional(),
      sessionRef: graphWorkflowExecutionSessionRefSchema.optional(),
      lastTurnUsage: graphWorkflowAgentSessionTurnUsageSchema
        .nullable()
        .default(null),
      rotateBeforeNextTurn: z.boolean().default(false),
      limitEvaluation: z.enum(["disabled", "unsupported"]),
      lastUsedAt: z.string(),
    }),
  ],
);
export type GraphWorkflowAgentSessionState = z.infer<
  typeof graphWorkflowAgentSessionStateSchema
>;

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
  workingDefinition: resolvedWorkflowSemanticDefinitionSchema,
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
  history: z.array(graphWorkflowExecutionEventSchema).default([]),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  secondaryHaltReasons: z.array(graphWorkflowHaltReasonSchema).default([]),
  pendingMergeRetry: z.array(z.string().trim().min(1)).default([]),
});
export type GraphWorkflowExecution = z.infer<
  typeof graphWorkflowExecutionSchema
>;

// ============================================================
// Workflow Runtime Edits
// ============================================================

const workflowRuntimeEditAddOperationSchema = z.object({
  type: z.literal("add"),
  contextId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
});

const workflowRuntimeEditUpdateOperationSchema = z
  .object({
    type: z.literal("update"),
    taskId: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    instructions: z.string().trim().min(1).optional(),
    metadata: z.record(z.string(), z.string()).nullable().optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined ||
      value.instructions !== undefined ||
      value.metadata !== undefined,
    {
      message: "At least one of title, instructions, or metadata is required",
    },
  );

const workflowRuntimeEditRemoveOperationSchema = z.object({
  type: z.literal("remove"),
  taskId: z.string().trim().min(1),
});

const workflowRuntimeEditReorderOperationSchema = z.object({
  type: z.literal("reorder"),
  contextId: z.string().trim().min(1),
  orderedTaskIds: z.array(z.string()).min(1),
});

const workflowRuntimeEditMoveOperationSchema = z.object({
  type: z.literal("move"),
  taskId: z.string().trim().min(1),
  targetContextId: z.string().trim().min(1),
  targetOrder: z.number().int().min(1),
});

const workflowRuntimeEditOperationSchema = z.discriminatedUnion("type", [
  workflowRuntimeEditAddOperationSchema,
  workflowRuntimeEditUpdateOperationSchema,
  workflowRuntimeEditRemoveOperationSchema,
  workflowRuntimeEditReorderOperationSchema,
  workflowRuntimeEditMoveOperationSchema,
]);
export const workflowRuntimeEditRequestSchema = z.object({
  operations: z.array(workflowRuntimeEditOperationSchema).min(1),
});
export type WorkflowRuntimeEditRequest = z.infer<
  typeof workflowRuntimeEditRequestSchema
>;

// ============================================================
// Workflow Plan / Generation
// ============================================================

const workflowGraphValidationErrorSchema = z.object({
  code: z.string().trim().min(1),
  message: z.string().trim().min(1),
  contextId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  edgeId: z.string().trim().min(1).optional(),
  operationIndex: z.number().int().min(0).optional(),
});
export type WorkflowGraphValidationError = z.infer<
  typeof workflowGraphValidationErrorSchema
>;

const workflowPlanReferenceSchema = z.object({
  filePath: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

export const workflowPlanRequestSchema = z.object({
  objective: z.string().trim().min(1),
  references: z.array(workflowPlanReferenceSchema).default([]),
  seedDefinitionId: z.string().trim().min(1).optional(),
});
export type WorkflowPlanRequest = z.infer<typeof workflowPlanRequestSchema>;

export const workflowGeneratedDraftSchema = z.object({
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
  validationErrors: z.array(workflowGraphValidationErrorSchema).default([]),
});
export type WorkflowGeneratedDraft = z.infer<
  typeof workflowGeneratedDraftSchema
>;

// ============================================================
// Collaboration Mode — asymmetric artifact contract
// ============================================================
// Source of truth: memory-bank/COLLABORATION_MODE_FLOW.md §"Agent output
// contract". The primary (agent_one) and secondary (agent_two) agents emit
// kind-discriminated artifact records (initial_draft, cross_review,
// proposed_changes, counter_proposal, resolution_decision, final_answer,
// open_conflicts). Convergence and routing are decided by the orchestrator
// from the resolution_decision artifact, not by the agent narrative.
//
// The severity / category / flow-agent / autonomous-threshold enums used by
// these artifacts are defined higher up in this file (so the agent-invoked
// collaboration config block can compose the threshold). The artifact
// schemas themselves remain here next to the per-artifact JSON-Schema
// projections in `types.ts`.

const collaborationReferenceSchema = z
  .object({
    artifact: z.string().min(1),
    locator: z.string().min(1).optional(),
  })
  .strict();
export type CollaborationReference = z.infer<
  typeof collaborationReferenceSchema
>;

const collaborationArtifactAgreementSchema = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1),
    ref: collaborationReferenceSchema.optional(),
  })
  .strict();
export type CollaborationArtifactAgreement = z.infer<
  typeof collaborationArtifactAgreementSchema
>;

const collaborationArtifactDisagreementSchema = z
  .object({
    id: z.string().min(1),
    category: collaborationDisagreementCategorySchema,
    severity: collaborationDisagreementSeveritySchema,
    claim: z.string().min(1),
    reason: z.string().min(1),
    proposedResolution: z.string().min(1).optional(),
    ref: collaborationReferenceSchema.optional(),
  })
  .strict();
export type CollaborationArtifactDisagreement = z.infer<
  typeof collaborationArtifactDisagreementSchema
>;

const collaborationUserQuestionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    relatedDisagreementIds: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationUserQuestion = z.infer<
  typeof collaborationUserQuestionSchema
>;

const collaborationReviseSelfArtifactSchema = z
  .object({
    change: z.string().min(1),
    because: z.string().min(1),
  })
  .strict();
export type CollaborationReviseSelfArtifact = z.infer<
  typeof collaborationReviseSelfArtifactSchema
>;

const collaborationChangeProposalSchema = z
  .object({
    id: z.string().min(1),
    change: z.string().min(1),
    rationale: z.string().min(1),
    addressesDisagreementIds: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationChangeProposal = z.infer<
  typeof collaborationChangeProposalSchema
>;

export const collaborationInitialDraftOutputSchema = z
  .object({
    kind: z.literal("initial_draft"),
    agent: collaborationFlowAgentSchema,
    narrative: z.string().min(1),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)),
    keyClaims: z.array(collaborationArtifactAgreementSchema),
  })
  .strict();
export type CollaborationInitialDraftOutput = z.infer<
  typeof collaborationInitialDraftOutputSchema
>;

export const collaborationCrossReviewOutputSchema = z
  .object({
    kind: z.literal("cross_review"),
    agent: collaborationFlowAgentSchema,
    targetAgent: collaborationFlowAgentSchema,
    narrative: z.string().min(1),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
    agree: z.array(collaborationArtifactAgreementSchema),
    disagree: z.array(collaborationArtifactDisagreementSchema),
    reviseSelf: z.array(collaborationReviseSelfArtifactSchema),
  })
  .strict();
export type CollaborationCrossReviewOutput = z.infer<
  typeof collaborationCrossReviewOutputSchema
>;

export const collaborationProposedChangesOutputSchema = z
  .object({
    kind: z.literal("proposed_changes"),
    agent: z.literal("agent_one"),
    targetAgent: z.literal("agent_two"),
    narrative: z.string().min(1),
    acceptedFromAgentTwoDraft: z.array(collaborationArtifactAgreementSchema),
    proposedChanges: z.array(collaborationChangeProposalSchema),
    remainingDisagreements: z.array(collaborationArtifactDisagreementSchema),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationProposedChangesOutput = z.infer<
  typeof collaborationProposedChangesOutputSchema
>;

export const collaborationCounterProposalOutputSchema = z
  .object({
    kind: z.literal("counter_proposal"),
    agent: z.literal("agent_two"),
    narrative: z.string().min(1),
    acceptedProposedChangeIds: z.array(z.string().min(1)),
    rejectedProposedChangeIds: z.array(z.string().min(1)),
    alternativeChanges: z.array(collaborationChangeProposalSchema),
    agree: z.array(collaborationArtifactAgreementSchema),
    disagree: z.array(collaborationArtifactDisagreementSchema),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationCounterProposalOutput = z.infer<
  typeof collaborationCounterProposalOutputSchema
>;

const collaborationResolutionDecisionNextActionSchema = z.enum([
  "final",
  "continue_negotiation",
  "ask_user",
  "fail",
]);
export type CollaborationResolutionDecisionNextAction = z.infer<
  typeof collaborationResolutionDecisionNextActionSchema
>;

const collaborationResolvedDisagreementSchema = z
  .object({
    disagreementId: z.string().min(1),
    resolution: z.string().min(1),
    resolvedAutonomously: z.boolean(),
    rationale: z.string().min(1),
  })
  .strict();
export type CollaborationResolvedDisagreement = z.infer<
  typeof collaborationResolvedDisagreementSchema
>;

export const collaborationResolutionDecisionOutputSchema = z
  .object({
    kind: z.literal("resolution_decision"),
    agent: z.literal("agent_one"),
    agreementReached: z.boolean(),
    nextAction: collaborationResolutionDecisionNextActionSchema,
    acceptedPoints: z.array(collaborationArtifactAgreementSchema),
    resolvedDisagreements: z.array(collaborationResolvedDisagreementSchema),
    remainingDisagreements: z.array(collaborationArtifactDisagreementSchema),
    userQuestions: z.array(collaborationUserQuestionSchema),
    rationale: z.string().min(1),
  })
  .strict();
export type CollaborationResolutionDecisionOutput = z.infer<
  typeof collaborationResolutionDecisionOutputSchema
>;

export const collaborationOpenConflictsOutputSchema = z
  .object({
    kind: z.literal("open_conflicts"),
    disagreements: z.array(collaborationArtifactDisagreementSchema),
    questions: z.array(collaborationUserQuestionSchema),
  })
  .strict();
export type CollaborationOpenConflictsOutput = z.infer<
  typeof collaborationOpenConflictsOutputSchema
>;

export const collaborationFinalAnswerOutputSchema = z
  .object({
    kind: z.literal("final_answer"),
    agent: z.literal("agent_one"),
    answer: z.string().min(1),
    report: z.string().min(1),
    supporting: z.array(z.string().min(1)),
  })
  .strict();
export type CollaborationFinalAnswerOutput = z.infer<
  typeof collaborationFinalAnswerOutputSchema
>;

export const collaborationArtifactSchema = z.discriminatedUnion("kind", [
  collaborationInitialDraftOutputSchema,
  collaborationCrossReviewOutputSchema,
  collaborationProposedChangesOutputSchema,
  collaborationCounterProposalOutputSchema,
  collaborationResolutionDecisionOutputSchema,
  collaborationOpenConflictsOutputSchema,
  collaborationFinalAnswerOutputSchema,
]);
export type CollaborationArtifact = z.infer<typeof collaborationArtifactSchema>;
