import { z } from "zod";

// ============================================================
// CSM Data Entity Schemas
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
  .enum(["initialization"])
  .nullable()
  .default(null);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

// ============================================================
// Conversation Metrics Schemas
// ============================================================

export const compactionEventSchema = z.object({
  trigger: z.enum(["manual", "auto"]),
  preTokens: z.number(),
  timestamp: z.string(),
});
export type CompactionEvent = z.infer<typeof compactionEventSchema>;

export const modelUsageEntrySchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  costUSD: z.number(),
  contextWindow: z.number(),
  maxOutputTokens: z.number(),
});
export type ModelUsageEntry = z.infer<typeof modelUsageEntrySchema>;

export const conversationMetricsSchema = z.object({
  // Token usage (cumulative across all API calls — NOT context fill level)
  inputTokens: z.number().nullable().default(null),
  outputTokens: z.number().nullable().default(null),
  cacheReadInputTokens: z.number().nullable().default(null),
  cacheCreationInputTokens: z.number().nullable().default(null),

  // Context window size (model's max, from modelUsage)
  contextWindow: z.number().nullable().default(null),

  // Per-model breakdown
  modelUsage: z
    .record(z.string(), modelUsageEntrySchema)
    .nullable()
    .default(null),

  // Timing (accumulated across prompts)
  durationMs: z.number().nullable().default(null),
  durationApiMs: z.number().nullable().default(null),
  // Turns (accumulated across prompts)
  numTurns: z.number().nullable().default(null),

  // Cost (accumulated across prompts)
  totalCostUsd: z.number().nullable().default(null),

  // Session metadata (from init)
  model: z.string().nullable().default(null),
  claudeCodeVersion: z.string().nullable().default(null),
  tools: z.array(z.string()).nullable().default(null),
  mcpServers: z
    .array(
      z.object({
        name: z.string(),
        status: z.string(),
      }),
    )
    .nullable()
    .default(null),

  // Compaction tracking
  compactionCount: z.number().default(0),
  lastCompactionPreTokens: z.number().nullable().default(null),
  compactions: z.array(compactionEventSchema).default([]),

  // Stop/error info
  stopReason: z.string().nullable().default(null),
  errorSubtype: z.string().nullable().default(null),
  permissionDenials: z.array(z.string()).nullable().default(null),
});
export type ConversationMetrics = z.infer<typeof conversationMetricsSchema>;

export const conversationStateSchema = z.object({
  id: z.string(),
  name: z.string().nullable().default(null),
  claudeSessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  status: conversationStatusSchema,
  promptCount: z.number(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  source: z.enum(["csm", "imported"]).default("csm"),
  summary: z.string().nullable().default(null),
  archived: z.boolean().default(false),
  metrics: conversationMetricsSchema.nullable().default(null),
  pendingQuestionId: z.string().nullable().default(null),
  pendingQuestions: z.array(askQuestionItemSchema).nullable().default(null),
  forkedFrom: forkedFromSchema,
  role: conversationRoleSchema,
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export const sessionSourceSchema = z.enum(["csm", "imported"]);
export type SessionSource = z.infer<typeof sessionSourceSchema>;

export const sessionCreationModeSchema = z.enum(["fast", "focus"]);
export type SessionCreationMode = z.infer<typeof sessionCreationModeSchema>;

export const sessionStateSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean(),
  finished: z.boolean().default(false),
  conversations: z.array(conversationStateSchema).default([]),
  source: sessionSourceSchema.default("csm"),
  objective: z.string().nullable().default(null),
  creationMode: sessionCreationModeSchema.default("fast"),
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

export const perRepoConfigSchema = z.object({
  initScriptPath: z.string().nullable(),
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

export const mergeRequestSchema = z.object({
  message: z.string().trim().min(1),
});
export type MergeRequest = z.infer<typeof mergeRequestSchema>;

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

export const metricsUpdateEventSchema = z.object({
  type: z.literal("metrics-update"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  metrics: conversationMetricsSchema.partial(),
});
export type MetricsUpdateEvent = z.infer<typeof metricsUpdateEventSchema>;

/** SSE event type */
export type SSEEvent =
  | ConversationStatusEvent
  | AskQuestionEvent
  | MetricsUpdateEvent;

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
