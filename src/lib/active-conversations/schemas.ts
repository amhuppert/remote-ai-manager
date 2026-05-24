import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import {
  graphWorkflowCleanupStatusValueSchema,
  graphWorkflowExecutionJoinKindSchema,
  graphWorkflowExecutionJoinStatusSchema,
  graphWorkflowHaltReasonSchema,
  graphWorkflowMergeStatusValueSchema,
} from "@/lib/workflows/schemas";

const activeConversationForkedFromSchema = z.object({
  conversationId: z.string(),
  messageIndex: z.number().int().min(0),
  mode: z.enum(["synthetic", "native"]),
});
export type ActiveConversationForkedFrom = z.infer<
  typeof activeConversationForkedFromSchema
>;

export const activeConversationSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["new", "running", "awaiting", "waiting_for_input"]),
  lastActivityAt: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  agentBackend: agentBackendSchema,
  summary: z.string().nullable(),
  pendingQuestion: z.string().nullable(),
  forkedFrom: activeConversationForkedFromSchema.nullable(),
  debugActive: z.boolean(),
  role: z.enum(["initialization", "iteration", "validator"]).nullable(),
  branchName: z.string().nullable(),
  lastActivitySummary: z.string().nullable(),
});
export type ActiveConversation = z.infer<typeof activeConversationSchema>;

const activeGraphWorkflowContextMergeProgressSchema = z.object({
  contextId: z.string(),
  branchName: z.string().nullable(),
  mergeStatus: graphWorkflowMergeStatusValueSchema,
  cleanupStatus: graphWorkflowCleanupStatusValueSchema,
  lastMergeError: z.string().nullable(),
});

const activeGraphWorkflowJoinProgressSchema = z.object({
  joinId: z.string(),
  kind: graphWorkflowExecutionJoinKindSchema,
  contextId: z.string().nullable(),
  targetLaneId: z.string(),
  sourceLaneIds: z.array(z.string()).default([]),
  mergedSourceLaneIds: z.array(z.string()).default([]),
  status: graphWorkflowExecutionJoinStatusSchema,
});

const activeGraphWorkflowFinalPublishProgressSchema = z.object({
  joinId: z.string(),
  targetLaneId: z.string(),
  sourceLaneIds: z.array(z.string()).default([]),
  mergedSourceLaneIds: z.array(z.string()).default([]),
  status: graphWorkflowExecutionJoinStatusSchema,
});

const activeGraphWorkflowExecutionSchema = z.object({
  executionId: z.string(),
  status: z.enum([
    "pending",
    "running",
    "paused",
    "completed",
    "halted",
    "aborted",
  ]),
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  activeContextIds: z.array(z.string()).default([]),
  activeContextTitles: z.array(z.string()).default([]),
  activeBatchIds: z.array(z.string()).default([]),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  contextMergeProgress: z
    .array(activeGraphWorkflowContextMergeProgressSchema)
    .default([]),
  activeJoinIds: z.array(z.string()).default([]),
  joinProgress: z.array(activeGraphWorkflowJoinProgressSchema).default([]),
  finalPublishState: activeGraphWorkflowFinalPublishProgressSchema
    .nullable()
    .default(null),
  completedContexts: z.number(),
  totalContexts: z.number(),
  startedAt: z.string(),
});

const activeCollaborationExecutionSchema = z.object({
  workflowId: z.string(),
  status: z.enum(["running", "paused"]),
  phase: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  conversationId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const activeConversationsResponseSchema = z.object({
  conversations: z.array(activeConversationSchema),
  graphWorkflowExecutions: z
    .array(activeGraphWorkflowExecutionSchema)
    .default([]),
  activeCollaborationExecutions: z
    .array(activeCollaborationExecutionSchema)
    .default([]),
});
