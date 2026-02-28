import { z } from "zod";

// ============================================================
// CC (Command Center) Data Entity Schemas
// ============================================================

export const claudeModelSchema = z.enum(["opus", "sonnet", "haiku"]);
export type ClaudeModel = z.infer<typeof claudeModelSchema>;

export const globalConfigSchema = z.object({
  baseDir: z.string(),
  ignorePatterns: z.array(z.string()),
  stateFilePath: z.string(),
  claudeTimeoutMs: z.number(),
  defaultModel: claudeModelSchema.default("opus"),
  maxTurns: z.number().int().positive().optional(),
  mergeCheckIntervalMs: z.number().int().positive().optional(),
  preMergeTimeoutMs: z.number().int().positive().optional(),
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

/** Session-level derived status (waiting_for_input > running > awaiting > idle) */
export type DerivedSessionStatus =
  | "waiting_for_input"
  | "running"
  | "awaiting"
  | "idle";

export const messageContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    name: z.string(),
    input: z.any().optional(),
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
  })
  .nullable()
  .default(null);
export type ForkedFrom = z.infer<typeof forkedFromSchema>;

export const conversationRoleSchema = z
  .enum(["initialization", "iteration"])
  .nullable()
  .default(null);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

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

export const fixPlanTaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  status: fixPlanTaskStatusSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
  skipReason: z.string().nullable().default(null),
  addedByIteration: z.number().nullable().default(null),
});
export type FixPlanTask = z.infer<typeof fixPlanTaskSchema>;

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
        priority: z.enum(["high", "medium", "low"]),
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
  z.object({ type: z.literal("test_saturation") }),
  z.object({
    type: z.literal("stalled_exit_signal"),
    remainingTasks: z.number(),
  }),
  z.object({ type: z.literal("aborted") }),
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
  "paused",
  "completed",
  "halted",
  "aborted",
]);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

// --- Workflow Entity ---
export const ralphLoopWorkflowSchema = z.object({
  status: workflowStatusSchema,
  objective: z.string(),
  fixPlan: z.array(fixPlanTaskSchema),
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
});
export type RalphLoopWorkflow = z.infer<typeof ralphLoopWorkflowSchema>;

// ============================================================
// Session & Project State
// ============================================================

export const sessionStateSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean(),
  finished: z.boolean().default(false),
  conversations: z.array(conversationStateSchema).default([]),
  source: sessionSourceSchema.default("cc"),
  objective: z.string().nullable().default(null),
  creationMode: sessionCreationModeSchema.default("fast"),
  workflow: ralphLoopWorkflowSchema.nullable().default(null),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

export const projectStateSchema = z.object({
  rootPath: z.string(),
  sessions: z.record(z.string(), sessionStateSchema),
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
  adopted: z.boolean().default(false),
});
export type DevServerStatusEvent = z.infer<typeof devServerStatusEventSchema>;

export const devServerRuntimeStateSchema = z.object({
  serverName: z.string(),
  command: z.string(),
  status: devServerStatusSchema,
  pid: z.number().nullable(),
  port: z.number().nullable(),
  remoteUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  recentOutput: z.array(z.string()),
  adopted: z.boolean().default(false),
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
  initScriptPath: z.string().nullable(),
  preMergeCommand: z.string().nullable().optional(),
  devServers: z.array(devServerConfigSchema).optional(),
});
export type PerRepoConfig = z.infer<typeof perRepoConfigSchema>;

// ============================================================
// API Request Schemas
// ============================================================

export const createSessionRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("fast"),
    sessionName: z.string().trim().min(1),
  }),
  z.object({
    mode: z.literal("focus"),
    objective: z.string().trim().min(1),
  }),
  z.object({
    mode: z.literal("optimistic"),
    instructions: z.string().trim().min(1),
  }),
]);
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const imagePayloadSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  base64Data: z.string().min(1),
});
export type ImagePayload = z.infer<typeof imagePayloadSchema>;

export const runPromptRequestSchema = z
  .object({
    prompt: z.string().trim(),
    modelId: claudeModelSchema.optional(),
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
  | DevServerStatusEvent;

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
