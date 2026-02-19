import { z } from "zod";

// ============================================================
// CSM Data Entity Schemas
// ============================================================

export const globalConfigSchema = z.object({
  baseDir: z.string(),
  ignorePatterns: z.array(z.string()),
  stateFilePath: z.string(),
  claudeTimeoutMs: z.number(),
});
export type GlobalConfig = z.infer<typeof globalConfigSchema>;

export const sessionStatusSchema = z.enum(["idle", "ready", "running"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const conversationStateSchema = z.object({
  id: z.string(),
  claudeSessionId: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  status: sessionStatusSchema,
  promptCount: z.number(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  source: z.enum(["csm", "imported"]).default("csm"),
  summary: z.string().nullable().default(null),
  archived: z.boolean().default(false),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

export const sessionStateSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean(),
  finished: z.boolean().default(false),
  conversations: z.array(conversationStateSchema).default([]),
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
  sessionName: z.string().min(1),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const runPromptRequestSchema = z.object({
  prompt: z.string().trim().min(1),
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
// Transcript Schemas
// ============================================================

export const contentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const transcriptEntrySchema = z.object({
  type: z.string().optional(),
  message: z
    .object({
      role: z.string().optional(),
      content: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
    })
    .optional(),
  timestamp: z.string().optional(),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

// ============================================================
// Hook Event Schemas
// ============================================================

export const hookEventDataSchema = z.object({
  session_id: z.string().optional(),
  transcript_path: z.string().optional(),
  cwd: z.string().optional(),
  hook_event_name: z.string().optional(),
});
export type HookEventData = z.infer<typeof hookEventDataSchema>;
