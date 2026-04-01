import { z } from "zod";

// ============================================================
// CC (Command Center) Data Entity Schemas
// ============================================================

export const claudeModelSchema = z.enum(["opus", "sonnet", "haiku"]);
export type ClaudeModel = z.infer<typeof claudeModelSchema>;

export const effortLevelSchema = z.enum(["low", "medium", "high", "max"]);
export type EffortLevel = z.infer<typeof effortLevelSchema>;

const MODEL_EFFORT_LEVELS: Record<ClaudeModel, EffortLevel[]> = {
  opus: ["low", "medium", "high", "max"],
  sonnet: ["low", "medium", "high"],
  haiku: [],
};

/** Returns the effort levels supported by the given model. */
export function getEffortLevelsForModel(model: ClaudeModel): EffortLevel[] {
  return MODEL_EFFORT_LEVELS[model];
}

/**
 * Clamps an effort level to the highest supported level for the given model.
 * Returns undefined if the model doesn't support effort levels at all.
 */
export function clampEffortToModel(
  effort: EffortLevel,
  model: ClaudeModel,
): EffortLevel | undefined {
  const supported = MODEL_EFFORT_LEVELS[model];
  if (supported.length === 0) return undefined;
  if (supported.includes(effort)) return effort;
  return supported[supported.length - 1];
}

// ============================================================
// Push Notification Config
// ============================================================

export const pushTriggerSchema = z.object({
  jobCompleted: z.boolean().default(true),
  waitingForInput: z.boolean().default(true),
  workflowCompleted: z.boolean().default(true),
  workflowHalted: z.boolean().default(true),
  conversationIdle: z.boolean().default(true),
});
export type PushTriggers = z.infer<typeof pushTriggerSchema>;

export const pushNotificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["ntfy"]).default("ntfy"),
  serverUrl: z.string().default("https://ntfy.sh"),
  topic: z.string().default(""),
  triggers: pushTriggerSchema.default({
    jobCompleted: true,
    waitingForInput: true,
    workflowCompleted: true,
    workflowHalted: true,
    conversationIdle: true,
  }),
});
export type PushNotificationConfig = z.infer<
  typeof pushNotificationConfigSchema
>;

// ============================================================
// Codex Config
// ============================================================

export const codexReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>;

export const codexConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model: z.string().trim().min(1).optional(),
  reasoningEffort: codexReasoningEffortSchema.optional(),
  timeout: z.number().positive().nullable().optional(),
});
export type CodexConfig = z.infer<typeof codexConfigSchema>;

export const globalConfigSchema = z.object({
  baseDir: z.string(),
  ignorePatterns: z.array(z.string()),
  stateFilePath: z.string(),
  claudeTimeoutMs: z.number(),
  defaultModel: claudeModelSchema.default("opus"),
  defaultEffort: effortLevelSchema.optional(),
  maxTurns: z.number().int().positive().optional(),
  mergeCheckIntervalMs: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  maxConcurrentQueries: z.number().int().positive().optional(),
  tailscaleEnabled: z.boolean().optional(),
  pushNotification: pushNotificationConfigSchema.optional(),
  codex: codexConfigSchema.optional(),
  idleQuerySessionTtlMs: z.number().int().positive().optional(),
  branchPrefix: z.string().optional(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export const conversationStatusSchema = z
  .enum(["new", "awaiting", "running", "waiting_for_input"])
  .or(
    z
      .enum(["idle", "ready"])
      .transform((v) =>
        v === "idle" ? ("new" as const) : ("awaiting" as const),
      ),
  );
export type ConversationStatus =
  | "new"
  | "awaiting"
  | "running"
  | "waiting_for_input";

/** Session-level derived status (waiting_for_input > running > awaiting > new > idle) */
export type DerivedSessionStatus =
  | "waiting_for_input"
  | "running"
  | "awaiting"
  | "new"
  | "idle";

export const messageContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.string().optional(),
  }),
  z.object({
    type: z.literal("command"),
    name: z.string(),
    args: z.string().nullable(),
  }),
  z.object({
    type: z.literal("image"),
    mediaType: z.string(),
    base64Data: z.string(),
  }),
  z.object({
    type: z.literal("image_ref"),
    mediaType: z.string(),
    imagePath: z.string(),
  }),
]);
export type MessageContentBlock = z.infer<typeof messageContentBlockSchema>;

// AskUserQuestion schemas (defined before conversationStateSchema which references them)
export const askQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type AskQuestionOption = z.infer<typeof askQuestionOptionSchema>;

export const askQuestionItemSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(askQuestionOptionSchema),
  multiSelect: z.boolean().default(false),
});
export type AskQuestionItem = z.infer<typeof askQuestionItemSchema>;

export const forkedFromSchema = z
  .object({
    sourceConversationId: z.string(),
    sourceClaudeSessionId: z.string(),
    messageIndex: z.number().int().min(0),
    /** UUID of the last assistant message before the fork point, used for SDK resumeSessionAt */
    forkPointAssistantUuid: z.string().nullable().default(null),
  })
  .nullable()
  .default(null);
export type ForkedFrom = z.infer<typeof forkedFromSchema>;

export const conversationRoleSchema = z
  .enum(["initialization", "iteration", "validator"])
  .nullable()
  .default(null);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

// ============================================================
// Debug Mode Schemas
// ============================================================

export const debugHypothesisSchema = z.object({
  id: z.string(),
  description: z.string(),
});
export type DebugHypothesis = z.infer<typeof debugHypothesisSchema>;

export const debugModePhaseSchema = z.enum([
  "hypothesizing",
  "awaiting_reproduction",
  "analyzing_evidence",
  "fixing",
  "awaiting_verification",
  "cleanup_instrumentation",
]);
export type DebugModePhase = z.infer<typeof debugModePhaseSchema>;

export const debugModeStateSchema = z.object({
  active: z.boolean(),
  recording: z.boolean(),
  logFilePath: z.string(),
  enteredAt: z.string(),
  hypotheses: z.array(debugHypothesisSchema).default([]),
  instructionsDelivered: z.boolean().default(false),
  phase: debugModePhaseSchema.default("hypothesizing"),
});
export type DebugModeState = z.infer<typeof debugModeStateSchema>;

export const debugLogEntrySchema = z.object({
  timestamp: z.string(),
  hypothesisId: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type DebugLogEntry = z.infer<typeof debugLogEntrySchema>;

export const debugProbeEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  description: z.string(),
});
export type DebugProbeEntry = z.infer<typeof debugProbeEntrySchema>;

export const debugInstrumentationManifestSchema = z.object({
  conversationId: z.string(),
  createdAt: z.string(),
  probes: z.array(debugProbeEntrySchema),
});
export type DebugInstrumentationManifest = z.infer<
  typeof debugInstrumentationManifestSchema
>;

export const conversationStateSchema = z.object({
  id: z.string(),
  name: z.string().nullable().default(null),
  claudeSessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  status: conversationStatusSchema,
  promptCount: z.number(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  source: z.enum(["cc", "imported"]).default("cc"),
  summary: z.string().nullable().default(null),
  archived: z.boolean().default(false),
  totalCostUsd: z.number().nullable().default(null),
  totalDurationMs: z.number().nullable().default(null),
  totalTurns: z.number().nullable().default(null),
  pendingQuestionId: z.string().nullable().default(null),
  pendingQuestions: z.array(askQuestionItemSchema).nullable().default(null),
  forkedFrom: forkedFromSchema,
  role: conversationRoleSchema,
  contextTokens: z.number().nullable().default(null),
  contextWindowMax: z.number().nullable().default(null),
  debugMode: debugModeStateSchema.nullable().default(null),
  machineSnapshot: z.unknown().nullable().default(null),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export const sessionSourceSchema = z.enum(["cc", "imported"]);
export type SessionSource = z.infer<typeof sessionSourceSchema>;

export const sessionCreationModeSchema = z.enum([
  "fast",
  "focus",
  "optimistic",
]);
export type SessionCreationMode = z.infer<typeof sessionCreationModeSchema>;

// ============================================================
// Ralph Loop Workflow Schemas
// (defined before sessionStateSchema so it can reference ralphLoopWorkflowSchema)
// ============================================================

// --- Fix Plan Task ---
export const fixPlanTaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "skipped",
]);
export type FixPlanTaskStatus = z.infer<typeof fixPlanTaskStatusSchema>;

const fixPlanTaskObjectSchema = z.object({
  id: z.string(),
  description: z.string(),
  group: z.number().int().min(1),
  status: fixPlanTaskStatusSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
  skipReason: z.string().nullable().default(null),
  addedByIteration: z.number().nullable().default(null),
});

/** Backward-compatible schema: migrates legacy `priority` field to `group`. */
export const fixPlanTaskSchema: z.ZodType<
  z.infer<typeof fixPlanTaskObjectSchema>
> = z.preprocess((val: unknown) => {
  if (
    val &&
    typeof val === "object" &&
    "priority" in val &&
    !("group" in val)
  ) {
    const v = val as Record<string, unknown>;
    const groupMap: Record<string, number> = { high: 1, medium: 2, low: 3 };
    const { priority: _, ...rest } = v;
    void _;
    return { ...rest, group: groupMap[v.priority as string] ?? 2 };
  }
  return val;
}, fixPlanTaskObjectSchema) as unknown as z.ZodType<
  z.infer<typeof fixPlanTaskObjectSchema>
>;
export type FixPlanTask = z.infer<typeof fixPlanTaskObjectSchema>;

// --- Circuit Breaker ---
export const circuitBreakerStateEnumSchema = z.enum([
  "closed",
  "half_open",
  "open",
]);
export type CircuitBreakerStateEnum = z.infer<
  typeof circuitBreakerStateEnumSchema
>;

export const circuitBreakerStateSchema = z.object({
  state: circuitBreakerStateEnumSchema,
  consecutiveNoProgress: z.number().default(0),
  consecutiveSameError: z.number().default(0),
  lastErrorPattern: z.string().nullable().default(null),
  lastProgressIteration: z.number().default(0),
});
export type CircuitBreakerState = z.infer<typeof circuitBreakerStateSchema>;

// --- Configuration ---
export const circuitBreakerConfigSchema = z.object({
  noProgressThreshold: z.number().int().min(1).default(3),
  sameErrorThreshold: z.number().int().min(1).default(5),
});
export type CircuitBreakerConfig = z.infer<typeof circuitBreakerConfigSchema>;

export const ralphLoopConfigSchema = z.object({
  maxIterations: z.number().int().min(1).max(100).default(20),
  iterationTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(7_200_000)
    .default(3_600_000),
  contextSoftLimitTokens: z
    .number()
    .int()
    .min(10_000)
    .max(500_000)
    .default(160_000),
  contextHardLimitTokens: z
    .number()
    .int()
    .min(10_000)
    .max(500_000)
    .default(180_000),
  circuitBreaker: circuitBreakerConfigSchema.default({
    noProgressThreshold: 3,
    sameErrorThreshold: 5,
  }),
  model: claudeModelSchema.default("opus"),
  effort: effortLevelSchema.default("high"),
});
export type RalphLoopConfig = z.infer<typeof ralphLoopConfigSchema>;

// --- Custom Tool Input Schemas ---
export const reportStatusInputSchema = z.object({
  status: z.enum(["in_progress", "complete", "blocked"]),
  exit_signal: z.boolean(),
  work_summary: z.string(),
  work_type: z.enum([
    "implementation",
    "testing",
    "documentation",
    "refactoring",
  ]),
});
export type ReportStatusInput = z.infer<typeof reportStatusInputSchema>;

export const updateFixPlanInputSchema = z.object({
  completedTaskIds: z.array(z.string()).optional(),
  skippedTasks: z
    .array(
      z.object({
        taskId: z.string(),
        reason: z.string(),
      }),
    )
    .optional(),
  newTasks: z
    .array(
      z.object({
        description: z.string(),
        group: z.number().int().min(1),
      }),
    )
    .optional(),
});
export type UpdateFixPlanInput = z.infer<typeof updateFixPlanInputSchema>;

// --- Halt Reason ---
export const haltReasonSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan_complete") }),
  z.object({ type: z.literal("iteration_cap"), maxIterations: z.number() }),
  z.object({
    type: z.literal("circuit_breaker"),
    reason: z.enum(["no_progress", "repeated_error"]),
  }),
  z.object({ type: z.literal("permission_denied") }),
  z.object({
    type: z.literal("stalled_exit_signal"),
    remainingTasks: z.number(),
  }),
  z.object({ type: z.literal("stopped") }),
  z.object({ type: z.literal("context_limit") }),
]);
export type HaltReason = z.infer<typeof haltReasonSchema>;

// --- Git Iteration Metrics ---
export const gitIterationMetricsSchema = z.object({
  filesChanged: z.number(),
  linesAdded: z.number(),
  linesRemoved: z.number(),
  changedFiles: z.array(z.string()),
});
export type GitIterationMetrics = z.infer<typeof gitIterationMetricsSchema>;

// --- Iteration Metadata ---
export const ralphLoopIterationMetaSchema = z.object({
  iterationNumber: z.number().int(),
  conversationId: z.string(),
  status: z.enum(["completed", "error", "timeout", "aborted", "context_limit"]),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  costUsd: z.number().default(0),
  turns: z.number().default(0),
  gitMetrics: gitIterationMetricsSchema,
  statusReport: reportStatusInputSchema.nullable().default(null),
  tasksCompleted: z.array(z.string()).default([]),
  tasksSkipped: z.array(z.string()).default([]),
  tasksAdded: z.array(z.string()).default([]),
  progressClassification: z.enum(["progress", "no_progress"]),
  peakContextTokens: z.number().default(0),
});
export type RalphLoopIterationMeta = z.infer<
  typeof ralphLoopIterationMetaSchema
>;

// --- Workflow Status ---
export const workflowStatusSchema = z.enum([
  "planning",
  "running",
  "stopped",
  "completed",
  "halted",
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

// --- Workflow Entity ---
export const ralphLoopWorkflowSchema = z
  .object({
    status: workflowStatusSchema,
    objective: z.string(),
    fixPlan: z.array(fixPlanTaskSchema),
    references: z
      .array(
        z.object({
          filePath: z.string(),
          description: z.string(),
        }),
      )
      .default([]),
    config: ralphLoopConfigSchema,
    circuitBreaker: circuitBreakerStateSchema,
    iterations: z.array(ralphLoopIterationMetaSchema).default([]),
    haltReason: haltReasonSchema.nullable().default(null),
    generatingPlan: z.boolean().default(false),
    createdAt: z.string(),
    startedAt: z.string().nullable().default(null),
    completedAt: z.string().nullable().default(null),
    totalCostUsd: z.number().default(0),
    totalDurationMs: z.number().default(0),
    currentIterationConversationId: z.string().nullable().default(null),
  })
  // Preserve _xstateSnapshot and other opaque fields across read/write cycles.
  // Without this, Zod's safeParse() in readState() strips unknown keys,
  // causing XState snapshot data to be lost on round-trip persistence.
  .passthrough();
export type RalphLoopWorkflow = z.infer<typeof ralphLoopWorkflowSchema>;

// ============================================================
// Graph Workflow Schemas
// (defined before sessionStateSchema so it can reference graphWorkflowExecutionSchema)
// ============================================================

export const graphWorkflowAgentConfigSchema = z.object({
  model: claudeModelSchema,
  reasoningEffort: effortLevelSchema,
});
export type GraphWorkflowAgentConfig = z.infer<
  typeof graphWorkflowAgentConfigSchema
>;

export const graphWorkflowMutabilityPolicySchema = z.object({
  allowAgentTaskAdd: z.boolean().default(false),
});
export type GraphWorkflowMutabilityPolicy = z.infer<
  typeof graphWorkflowMutabilityPolicySchema
>;

export const graphWorkflowCircuitBreakerConditionSchema = z.enum([
  "retry_exhaustion",
]);
export type GraphWorkflowCircuitBreakerCondition = z.infer<
  typeof graphWorkflowCircuitBreakerConditionSchema
>;

export const graphWorkflowCircuitBreakerPolicySchema = z.object({});
export type GraphWorkflowCircuitBreakerPolicy = z.infer<
  typeof graphWorkflowCircuitBreakerPolicySchema
>;

export const graphWorkflowIterationPolicySchema = z
  .object({
    maxIterations: z.number().int().min(1),
    contextSoftLimitTokens: z.number().int().positive().optional(),
    contextHardLimitTokens: z.number().int().positive().optional(),
  })
  .refine(
    (value) =>
      value.contextSoftLimitTokens === undefined ||
      value.contextHardLimitTokens === undefined ||
      value.contextSoftLimitTokens <= value.contextHardLimitTokens,
    {
      message: "contextSoftLimitTokens cannot exceed contextHardLimitTokens",
      path: ["contextSoftLimitTokens"],
    },
  );
export type GraphWorkflowIterationPolicy = z.infer<
  typeof graphWorkflowIterationPolicySchema
>;

const graphWorkflowValidatorBaseSchema = z.object({
  enabled: z.boolean(),
  autoCreateFixTasks: z.boolean().default(false),
  instructions: z.string().trim().min(1),
});

export const graphWorkflowClaudeValidatorConfigSchema =
  graphWorkflowValidatorBaseSchema.extend({
    type: z.literal("claude"),
    agent: graphWorkflowAgentConfigSchema,
  });

export const graphWorkflowCodexValidatorConfigSchema =
  graphWorkflowValidatorBaseSchema.extend({
    type: z.literal("codex"),
    codex: z
      .object({
        model: z.string().trim().min(1).optional(),
        reasoningEffort: codexReasoningEffortSchema.optional(),
      })
      .default({}),
  });

export const graphWorkflowAgentValidatorConfigSchema = z.preprocess(
  (val) => {
    if (
      typeof val === "object" &&
      val !== null &&
      !("type" in val) &&
      "agent" in val
    ) {
      return { ...val, type: "claude" };
    }
    return val;
  },
  z.discriminatedUnion("type", [
    graphWorkflowClaudeValidatorConfigSchema,
    graphWorkflowCodexValidatorConfigSchema,
  ]),
);
export type GraphWorkflowAgentValidatorConfig = z.infer<
  typeof graphWorkflowAgentValidatorConfigSchema
>;
export type GraphWorkflowClaudeValidatorConfig = z.infer<
  typeof graphWorkflowClaudeValidatorConfigSchema
>;
export type GraphWorkflowCodexValidatorConfig = z.infer<
  typeof graphWorkflowCodexValidatorConfigSchema
>;

export const graphWorkflowScriptValidatorConfigSchema = z.object({
  enabled: z.boolean(),
});
export type GraphWorkflowScriptValidatorConfig = z.infer<
  typeof graphWorkflowScriptValidatorConfigSchema
>;

export const graphWorkflowValidationFailurePolicySchema = z.object({
  mode: z.enum(["halt", "retry"]),
  retryScope: z.literal("same_context"),
  maxAttempts: z.number().int().min(1),
});
export type GraphWorkflowValidationFailurePolicy = z.infer<
  typeof graphWorkflowValidationFailurePolicySchema
>;

export const graphWorkflowTaskValidationSchema =
  graphWorkflowAgentValidatorConfigSchema;
export type GraphWorkflowTaskValidation = z.infer<
  typeof graphWorkflowTaskValidationSchema
>;

export const graphWorkflowContextValidationSchema = z.object({
  agentValidator: graphWorkflowAgentValidatorConfigSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  onFail: graphWorkflowValidationFailurePolicySchema,
});
export type GraphWorkflowContextValidation = z.infer<
  typeof graphWorkflowContextValidationSchema
>;

export const graphWorkflowExecutionContextDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  description: z.preprocess(
    (val) => (typeof val === "string" && val.trim() === "" ? undefined : val),
    z.string().trim().min(1).optional(),
  ),
  agent: graphWorkflowAgentConfigSchema,
  mutability: graphWorkflowMutabilityPolicySchema,
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema,
  iterationPolicy: graphWorkflowIterationPolicySchema,
  taskValidation: graphWorkflowTaskValidationSchema.optional(),
  contextValidation: graphWorkflowContextValidationSchema.optional(),
});
export type GraphWorkflowExecutionContextDefinition = z.infer<
  typeof graphWorkflowExecutionContextDefinitionSchema
>;

export const graphWorkflowTaskSourceSchema = z.enum([
  "user",
  "agent",
  "validator",
]);
export type GraphWorkflowTaskSource = z.infer<
  typeof graphWorkflowTaskSourceSchema
>;

export const graphWorkflowTaskDefinitionSchema = z.object({
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

export const graphWorkflowContextEdgeSchema = z.object({
  id: z.string().trim().min(1),
  sourceContextId: z.string().trim().min(1),
  targetContextId: z.string().trim().min(1),
});
export type GraphWorkflowContextEdge = z.infer<
  typeof graphWorkflowContextEdgeSchema
>;

export const workflowSemanticDefinitionSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
  executionContexts: z
    .array(graphWorkflowExecutionContextDefinitionSchema)
    .default([]),
  tasks: z.array(graphWorkflowTaskDefinitionSchema).default([]),
  edges: z.array(graphWorkflowContextEdgeSchema).default([]),
});
export type WorkflowSemanticDefinition = z.infer<
  typeof workflowSemanticDefinitionSchema
>;

export const graphWorkflowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type GraphWorkflowPosition = z.infer<typeof graphWorkflowPositionSchema>;

export const graphWorkflowViewportSchema = z.object({
  x: z.number().default(0),
  y: z.number().default(0),
  zoom: z.number().positive().default(1),
});
export type GraphWorkflowViewport = z.infer<typeof graphWorkflowViewportSchema>;

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

export const workflowValidatorIssueSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
});
export type WorkflowValidatorIssue = z.infer<
  typeof workflowValidatorIssueSchema
>;

export const workflowAgentValidatorResultSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  reopenTaskIds: z.array(z.string()).default([]),
  issues: z.array(workflowValidatorIssueSchema).default([]),
});
export type WorkflowAgentValidatorResult = z.infer<
  typeof workflowAgentValidatorResultSchema
>;

export const graphWorkflowSharedDocumentEntrySchema = z.object({
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

export const graphWorkflowStatusSchema = z.enum([
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
  "validating",
  "completed",
  "halted",
]);
export type GraphWorkflowContextStatus = z.infer<
  typeof graphWorkflowContextStatusSchema
>;

export const graphWorkflowTaskStatusSchema = z.enum([
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
]);
export type GraphWorkflowHaltReason = z.infer<
  typeof graphWorkflowHaltReasonSchema
>;

export const graphWorkflowExecutionContextStateSchema = z.object({
  contextId: z.string().trim().min(1),
  status: graphWorkflowContextStatusSchema,
  totalTaskCount: z.number().int().min(0),
  completedTaskCount: z.number().int().min(0).default(0),
  iterationCount: z.number().int().min(0).default(0),
  consecutiveFailureCount: z.number().int().min(0).default(0),
  lastValidationAt: z.string().nullable().default(null),
  lastValidationPass: z.boolean().nullable().default(null),
});
export type GraphWorkflowExecutionContextState = z.infer<
  typeof graphWorkflowExecutionContextStateSchema
>;

export const graphWorkflowTaskStateSchema = z.object({
  taskId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  order: z.number().int().min(1),
  status: graphWorkflowTaskStatusSchema,
  summary: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  lastConversationId: z.string().nullable().default(null),
  reopenedCount: z.number().int().min(0).default(0),
  lastReopenedAt: z.string().nullable().default(null),
  failureMessage: z.string().nullable().default(null),
});
export type GraphWorkflowTaskState = z.infer<
  typeof graphWorkflowTaskStateSchema
>;

export const graphWorkflowRetryStateSchema = z.object({
  contextId: z.string().trim().min(1),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
});
export type GraphWorkflowRetryState = z.infer<
  typeof graphWorkflowRetryStateSchema
>;

export const graphWorkflowValidatorTypeSchema = z.enum([
  "task",
  "context",
  "script",
]);
export type GraphWorkflowValidatorType = z.infer<
  typeof graphWorkflowValidatorTypeSchema
>;

export const graphWorkflowStatusEventSchema = z.object({
  type: z.literal("graph-workflow-status"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  workflowStatus: graphWorkflowStatusSchema,
  activeContextId: z.string().nullable().default(null),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
});
export type GraphWorkflowStatusEvent = z.infer<
  typeof graphWorkflowStatusEventSchema
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
});
export type GraphWorkflowTaskStatusEvent = z.infer<
  typeof graphWorkflowTaskStatusEventSchema
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
  issues: z.array(workflowValidatorIssueSchema).default([]),
  reopenTaskIds: z.array(z.string()).default([]),
});
export type GraphWorkflowValidationResultEvent = z.infer<
  typeof graphWorkflowValidationResultEventSchema
>;

export const graphWorkflowRetryEventSchema = z.object({
  type: z.literal("graph-workflow-retry"),
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  contextId: z.string(),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
});
export type GraphWorkflowRetryEvent = z.infer<
  typeof graphWorkflowRetryEventSchema
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

export const graphWorkflowSseEventSchema = z.discriminatedUnion("type", [
  graphWorkflowStatusEventSchema,
  graphWorkflowContextStatusEventSchema,
  graphWorkflowTaskStatusEventSchema,
  graphWorkflowValidationResultEventSchema,
  graphWorkflowRetryEventSchema,
  graphWorkflowCircuitBreakerEventSchema,
  graphWorkflowSharedDocumentsUpdatedEventSchema,
]);
export type GraphWorkflowSSEEvent = z.infer<typeof graphWorkflowSseEventSchema>;

export const graphWorkflowExecutionEventSchema = z.object({
  occurredAt: z.string(),
  event: graphWorkflowSseEventSchema,
});
export type GraphWorkflowExecutionEvent = z.infer<
  typeof graphWorkflowExecutionEventSchema
>;

export const graphWorkflowExecutionSchema = z.object({
  id: z.string().trim().min(1),
  seedDefinitionId: z.string().trim().min(1),
  seedDefinitionRevision: z.number().int().min(1),
  workingDefinition: workflowSemanticDefinitionSchema,
  status: graphWorkflowStatusSchema,
  activeContextId: z.string().nullable().default(null),
  contextStates: z
    .record(z.string(), graphWorkflowExecutionContextStateSchema)
    .default({}),
  taskStates: z.record(z.string(), graphWorkflowTaskStateSchema).default({}),
  retryState: z.record(z.string(), graphWorkflowRetryStateSchema).default({}),
  sharedDocuments: z.array(graphWorkflowSharedDocumentEntrySchema).default([]),
  machineSnapshot: z.unknown().nullable().default(null),
  history: z.array(graphWorkflowExecutionEventSchema).default([]),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
});
export type GraphWorkflowExecution = z.infer<
  typeof graphWorkflowExecutionSchema
>;

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

export const workflowRuntimeEditOperationSchema = z.discriminatedUnion("type", [
  workflowRuntimeEditAddOperationSchema,
  workflowRuntimeEditUpdateOperationSchema,
  workflowRuntimeEditRemoveOperationSchema,
  workflowRuntimeEditReorderOperationSchema,
  workflowRuntimeEditMoveOperationSchema,
]);
export type WorkflowRuntimeEditOperation = z.infer<
  typeof workflowRuntimeEditOperationSchema
>;

export const workflowRuntimeEditRequestSchema = z.object({
  operations: z.array(workflowRuntimeEditOperationSchema).min(1),
});
export type WorkflowRuntimeEditRequest = z.infer<
  typeof workflowRuntimeEditRequestSchema
>;

export const workflowGraphValidationErrorSchema = z.object({
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

export const workflowPlanReferenceSchema = z.object({
  filePath: z.string().trim().min(1),
  description: z.string().trim().min(1),
});
export type WorkflowPlanReference = z.infer<typeof workflowPlanReferenceSchema>;

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
// Roadmap Item Schemas
// ============================================================

export const roadmapItemTypeSchema = z.enum(["bug", "feature", "idea"]);
export type RoadmapItemType = z.infer<typeof roadmapItemTypeSchema>;

export const roadmapItemStatusSchema = z.enum(["incomplete", "done"]);
export type RoadmapItemStatus = z.infer<typeof roadmapItemStatusSchema>;

export const roadmapItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().default(null),
  type: roadmapItemTypeSchema,
  status: roadmapItemStatusSchema.default("incomplete"),
  archived: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RoadmapItem = z.infer<typeof roadmapItemSchema>;

// ============================================================
// Reference Documents
// ============================================================

export const referenceDocumentSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  description: z.string(),
  createdAt: z.string(),
});
export type ReferenceDocument = z.infer<typeof referenceDocumentSchema>;

// ============================================================
// Session & Project State
// ============================================================

export const sessionStateSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean().default(false),
  finished: z.boolean().default(false),
  conversations: z.array(conversationStateSchema).default([]),
  source: sessionSourceSchema.default("cc"),
  objective: z.string().nullable().default(null),
  creationMode: sessionCreationModeSchema.default("fast"),
  tddEnabled: z.boolean().default(true),
  targetBranch: z.string().default("main"),
  parentSessionName: z.string().nullable().default(null),
  workflow: ralphLoopWorkflowSchema.nullable().default(null),
  workflowHistory: z.array(ralphLoopWorkflowSchema).default([]),
  graphWorkflowExecution: graphWorkflowExecutionSchema.nullable().default(null),
  graphWorkflowExecutionHistory: z
    .array(graphWorkflowExecutionSchema)
    .default([]),
  referenceDocuments: z.array(referenceDocumentSchema).default([]),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

export const projectStateSchema = z.object({
  rootPath: z.string(),
  sessions: z.record(z.string(), sessionStateSchema),
  roadmapItems: z.array(roadmapItemSchema).default([]),
});
export type ProjectState = z.infer<typeof projectStateSchema>;

export const managerStateSchema = z.object({
  projects: z.record(z.string(), projectStateSchema),
  archivedProjects: z.array(z.string()).default([]),
  pinnedProjects: z.array(z.string()).default([]),
});
export type ManagerState = z.infer<typeof managerStateSchema>;

// ============================================================
// Dev Server Schemas
// ============================================================

export const devServerConfigSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
});
export type DevServerConfig = z.infer<typeof devServerConfigSchema>;

export const devServerStatusSchema = z.enum([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type DevServerStatus = z.infer<typeof devServerStatusSchema>;

export const devServerStatusEventSchema = z.object({
  type: z.literal("dev-server-status"),
  projectName: z.string(),
  sessionName: z.string(),
  serverName: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type DevServerStatusEvent = z.infer<typeof devServerStatusEventSchema>;

export const devServerRuntimeStateSchema = z.object({
  serverName: z.string(),
  command: z.string(),
  status: devServerStatusSchema,
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  recentOutput: z.array(z.string()),
});
export type DevServerRuntimeState = z.infer<typeof devServerRuntimeStateSchema>;

export const devServersStatusResponseSchema = z.object({
  servers: z.array(devServerRuntimeStateSchema),
});
export type DevServersStatusResponse = z.infer<
  typeof devServersStatusResponseSchema
>;

// ============================================================
// Per-Repo Config
// ============================================================

export const perRepoConfigSchema = z.object({
  initScriptPath: z.string().nullable().optional(),
  preMergeCommand: z.string().nullable().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
  devServers: z.array(devServerConfigSchema).optional(),
  branchPrefix: z.string().optional(),
});
export type PerRepoConfig = z.infer<typeof perRepoConfigSchema>;

// ============================================================
// API Request Schemas
// ============================================================

export const createRoadmapItemRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  type: roadmapItemTypeSchema,
});
export type CreateRoadmapItemRequest = z.infer<
  typeof createRoadmapItemRequestSchema
>;

export const updateRoadmapItemRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    status: roadmapItemStatusSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.title !== undefined ||
      d.description !== undefined ||
      d.status !== undefined ||
      d.archived !== undefined,
    {
      message:
        "At least one of title, description, status, or archived is required",
    },
  );
export type UpdateRoadmapItemRequest = z.infer<
  typeof updateRoadmapItemRequestSchema
>;

export const imagePayloadSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  base64Data: z.string().min(1),
});
export type ImagePayload = z.infer<typeof imagePayloadSchema>;

export const createSessionRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("fast"),
    sessionName: z.string().trim().min(1),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
  z.object({
    mode: z.literal("focus"),
    objective: z.string().trim().min(1),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
  z.object({
    mode: z.literal("optimistic"),
    instructions: z.string().trim().min(1),
    images: z.array(imagePayloadSchema).max(5).optional(),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
]);
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const runPromptRequestSchema = z
  .object({
    prompt: z.string().trim(),
    modelId: claudeModelSchema.optional(),
    effort: effortLevelSchema.optional(),
    images: z.array(imagePayloadSchema).max(5).optional(),
  })
  .refine(
    (data) => data.prompt.length > 0 || (data.images && data.images.length > 0),
    { message: "Either prompt text or at least one image is required" },
  );
export type RunPromptRequest = z.infer<typeof runPromptRequestSchema>;

export const commitRequestSchema = z.object({
  message: z.string().trim().min(1),
});
export type CommitRequest = z.infer<typeof commitRequestSchema>;

export const sessionArchiveRequestSchema = z.object({
  archived: z.boolean(),
});
export type SessionArchiveRequest = z.infer<typeof sessionArchiveRequestSchema>;

export const sessionTddRequestSchema = z.object({
  tddEnabled: z.boolean(),
});
export type SessionTddRequest = z.infer<typeof sessionTddRequestSchema>;

export const renameConversationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type RenameConversationRequest = z.infer<
  typeof renameConversationRequestSchema
>;

export const forkRequestSchema = z.object({
  messageIndex: z.number().int().min(0),
  editedText: z.string().trim().min(1).optional(),
});
export type ForkRequest = z.infer<typeof forkRequestSchema>;

export const debugModeRequestSchema = z.object({
  action: z.enum(["enter", "exit", "mark_reproduced", "mark_fix_verified"]),
});
export type DebugModeRequest = z.infer<typeof debugModeRequestSchema>;

export const debugRecordingRequestSchema = z.object({
  recording: z.boolean(),
});
export type DebugRecordingRequest = z.infer<typeof debugRecordingRequestSchema>;

// ============================================================
// Git Operations Schemas
// ============================================================

export const commitLogEntrySchema = z.object({
  hash: z.string(),
  fullHash: z.string(),
  message: z.string(),
  date: z.string(),
  filesChanged: z.number(),
});
export type CommitLogEntry = z.infer<typeof commitLogEntrySchema>;

// ============================================================
// SSE Event Schemas
// ============================================================

export const conversationStatusEventSchema = z.object({
  type: z.literal("conversation-status"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  status: z.enum(["running", "awaiting", "waiting_for_input"]),
  error: z.string().optional(),
});
export type ConversationStatusEvent = z.infer<
  typeof conversationStatusEventSchema
>;

// ============================================================
// AskUserQuestion Event Schemas
// ============================================================

export const askQuestionEventSchema = z.object({
  type: z.literal("ask-question"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  questionId: z.string(),
  questions: z.array(askQuestionItemSchema),
});
export type AskQuestionEvent = z.infer<typeof askQuestionEventSchema>;

export const answerQuestionRequestSchema = z.object({
  questionId: z.string(),
  answers: z.record(z.string(), z.string()),
});
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequestSchema>;

// ============================================================
// Background Job Schemas
// ============================================================

export const jobTypeSchema = z.enum(["commit", "merge", "resolve-conflicts"]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "conflicts",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobStatusEventSchema = z.object({
  type: z.literal("job-status"),
  jobType: jobTypeSchema,
  status: jobStatusSchema,
  projectName: z.string(),
  sessionName: z.string(),
  jobId: z.string(),
  branchName: z.string(),
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
  phase: z.string().optional(),
});
export type JobStatusEvent = z.infer<typeof jobStatusEventSchema>;

export const jobDispatchResponseSchema = z.object({
  jobId: z.string(),
  jobType: jobTypeSchema,
  branchName: z.string(),
  startedAt: z.string(),
});
export type JobDispatchResponse = z.infer<typeof jobDispatchResponseSchema>;

export const smartMergeRequestSchema = z.object({
  autoResolve: z.boolean(),
});
export type SmartMergeRequest = z.infer<typeof smartMergeRequestSchema>;

export const conflictEntrySchema = z.object({
  file: z.string(),
  description: z.string(),
  resolution: z.string(),
  rationale: z.string(),
});
export type ConflictEntry = z.infer<typeof conflictEntrySchema>;

export const conflictDecisionInputSchema = z.object({
  file: z.string(),
  decision: z.enum(["approved", "rejected", "pending"]),
  feedback: z.string().optional(),
});
export type ConflictDecisionInput = z.infer<typeof conflictDecisionInputSchema>;

export const resolveConflictsRequestSchema = z.object({
  decisions: z.array(conflictDecisionInputSchema).optional(),
});
export type ResolveConflictsRequest = z.infer<
  typeof resolveConflictsRequestSchema
>;

// ============================================================
// Workflow SSE Event Schemas
// ============================================================

export const workflowStatusEventSchema = z.object({
  type: z.literal("workflow-status"),
  projectName: z.string(),
  sessionName: z.string(),
  workflowStatus: workflowStatusSchema,
  iterationCount: z.number(),
  maxIterations: z.number(),
  taskProgress: z.object({
    total: z.number(),
    completed: z.number(),
    skipped: z.number(),
    pending: z.number(),
  }),
  haltReason: haltReasonSchema.nullable(),
});
export type WorkflowStatusEvent = z.infer<typeof workflowStatusEventSchema>;

export const workflowIterationCompleteEventSchema = z.object({
  type: z.literal("workflow-iteration-complete"),
  projectName: z.string(),
  sessionName: z.string(),
  iteration: ralphLoopIterationMetaSchema,
});
export type WorkflowIterationCompleteEvent = z.infer<
  typeof workflowIterationCompleteEventSchema
>;

export const workflowFixPlanUpdatedEventSchema = z.object({
  type: z.literal("workflow-fix-plan-updated"),
  projectName: z.string(),
  sessionName: z.string(),
  fixPlan: z.array(fixPlanTaskSchema),
  source: z.enum(["tool", "user"]),
});
export type WorkflowFixPlanUpdatedEvent = z.infer<
  typeof workflowFixPlanUpdatedEventSchema
>;

export const workflowCircuitBreakerEventSchema = z.object({
  type: z.literal("workflow-circuit-breaker"),
  projectName: z.string(),
  sessionName: z.string(),
  circuitBreaker: circuitBreakerStateSchema,
});
export type WorkflowCircuitBreakerEvent = z.infer<
  typeof workflowCircuitBreakerEventSchema
>;

export const sessionFinishedEventSchema = z.object({
  type: z.literal("session-finished"),
  projectName: z.string(),
  sessionName: z.string(),
  branchName: z.string(),
  detectionMethod: z.enum(["ancestor", "commit-message"]),
});
export type SessionFinishedEvent = z.infer<typeof sessionFinishedEventSchema>;

// ============================================================
// Notification Schemas
// ============================================================

export const notificationTypeSchema = z.enum([
  "merge-completed",
  "merge-failed",
  "merge-conflicts",
  "commit-completed",
  "commit-failed",
  "resolve-completed",
  "resolve-failed",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  type: notificationTypeSchema,
  title: z.string(),
  message: z.string(),
  read: z.boolean(),
  projectName: z.string(),
  sessionName: z.string(),
  branchName: z.string(),
  jobId: z.string(),
  jobType: jobTypeSchema,
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  targetBranch: z.string().optional(),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationCreatedEventSchema = z.object({
  type: z.literal("notification-created"),
  notification: notificationSchema,
});
export type NotificationCreatedEvent = z.infer<
  typeof notificationCreatedEventSchema
>;

export const notificationUpdatedEventSchema = z.object({
  type: z.literal("notification-updated"),
  id: z.string(),
  read: z.boolean(),
});
export type NotificationUpdatedEvent = z.infer<
  typeof notificationUpdatedEventSchema
>;

export const getNotificationsQuerySchema = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type GetNotificationsQuery = z.infer<typeof getNotificationsQuerySchema>;

export const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  total: z.number(),
  unreadCount: z.number(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const markReadRequestSchema = z.object({
  read: z.literal(true),
});
export type MarkReadRequest = z.infer<typeof markReadRequestSchema>;

export const messageQueuedEventSchema = z.object({
  type: z.literal("message-queued"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  text: z.string(),
});
export type MessageQueuedEvent = z.infer<typeof messageQueuedEventSchema>;

// ============================================================
// Debug Mode SSE Event Schemas
// ============================================================

export const debugModeStatusEventSchema = z.object({
  type: z.literal("debug-mode-status"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  active: z.boolean(),
  recording: z.boolean(),
});
export type DebugModeStatusEvent = z.infer<typeof debugModeStatusEventSchema>;

export const debugLogReceivedEventSchema = z.object({
  type: z.literal("debug-log-received"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  entryCount: z.number(),
});
export type DebugLogReceivedEvent = z.infer<typeof debugLogReceivedEventSchema>;

/** SSE event type */
export type SSEEvent =
  | ConversationStatusEvent
  | AskQuestionEvent
  | JobStatusEvent
  | SessionFinishedEvent
  | NotificationCreatedEvent
  | NotificationUpdatedEvent
  | MessageQueuedEvent
  | WorkflowStatusEvent
  | WorkflowIterationCompleteEvent
  | WorkflowFixPlanUpdatedEvent
  | WorkflowCircuitBreakerEvent
  | GraphWorkflowStatusEvent
  | GraphWorkflowContextStatusEvent
  | GraphWorkflowTaskStatusEvent
  | GraphWorkflowValidationResultEvent
  | GraphWorkflowRetryEvent
  | GraphWorkflowCircuitBreakerEvent
  | GraphWorkflowSharedDocumentsUpdatedEvent
  | DevServerStatusEvent
  | DebugModeStatusEvent
  | DebugLogReceivedEvent;

// ============================================================
// Command Autocomplete Schemas
// ============================================================

export const commandTypeSchema = z.enum(["command", "skill"]);
export type CommandType = z.infer<typeof commandTypeSchema>;

export const commandItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  argumentHint: z.string().optional(),
  type: commandTypeSchema,
  source: z.string(),
});
export type CommandItem = z.infer<typeof commandItemSchema>;

export const commandsResponseSchema = z.object({
  items: z.array(commandItemSchema),
});
export type CommandsResponse = z.infer<typeof commandsResponseSchema>;

// ============================================================
// File Autocomplete Schemas
// ============================================================

export const fileItemSchema = z.object({
  path: z.string(),
});
export type FileItem = z.infer<typeof fileItemSchema>;

export const projectFilesResponseSchema = z.object({
  items: z.array(fileItemSchema),
});
export type ProjectFilesResponse = z.infer<typeof projectFilesResponseSchema>;
