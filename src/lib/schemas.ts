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
  maxTurns: z.number().int().positive().default(50),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export const conversationStatusSchema = z
  .enum(["new", "awaiting", "running"])
  .or(
    z
      .enum(["idle", "ready"])
      .transform((v) =>
        v === "idle" ? ("new" as const) : ("awaiting" as const),
      ),
  );
export type ConversationStatus = "new" | "awaiting" | "running";

/** Session-level derived status (running > awaiting > idle) */
export type DerivedSessionStatus = "running" | "awaiting" | "idle";

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
]);
export type MessageContentBlock = z.infer<typeof messageContentBlockSchema>;

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
  totalCostUsd: z.number().nullable().default(null),
  totalDurationMs: z.number().nullable().default(null),
  totalTurns: z.number().nullable().default(null),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export const sessionSourceSchema = z.enum(["csm", "imported"]);
export type SessionSource = z.infer<typeof sessionSourceSchema>;

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

export const createSessionRequestSchema = z.object({
  objective: z.string().trim().min(1),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const runPromptRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  modelId: claudeModelSchema.optional(),
});
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
  status: z.enum(["running", "awaiting"]),
});
export type ConversationStatusEvent = z.infer<
  typeof conversationStatusEventSchema
>;

/** SSE event type */
export type SSEEvent = ConversationStatusEvent;

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
