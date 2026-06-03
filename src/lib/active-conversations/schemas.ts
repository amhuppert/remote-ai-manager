import { z } from "zod";
import { askQuestionItemSchema } from "@/lib/conversations/schemas";
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

// Fields common to both scopes. The session variant adds the owning session's
// identity (`sessionName`, `branchName`); the project variant omits them — a
// session-less project conversation runs in the project's main worktree, so
// `worktreePath` is the project root and there is no session branch.
const activeConversationSharedFields = {
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["new", "running", "awaiting", "waiting_for_input"]),
  lastActivityAt: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  agentBackend: agentBackendSchema,
  summary: z.string().nullable(),
  pendingQuestion: z.string().nullable(),
  pendingQuestionId: z.string().nullable(),
  pendingQuestions: askQuestionItemSchema.array().nullable(),
  forkedFrom: activeConversationForkedFromSchema.nullable(),
  debugActive: z.boolean(),
  role: z
    .enum(["initialization", "iteration", "validator", "planner"])
    .nullable(),
  worktreePath: z.string(),
  lastActivitySummary: z.string().nullable(),
  unread: z.boolean(),
};

export const activeConversationSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("session"),
    ...activeConversationSharedFields,
    sessionName: z.string(),
    branchName: z.string().nullable(),
  }),
  z.object({
    scope: z.literal("project"),
    ...activeConversationSharedFields,
  }),
]);
export type ActiveConversation = z.infer<typeof activeConversationSchema>;

/** The session-scoped variant — carries `sessionName`/`branchName`. */
export type SessionActiveConversation = Extract<
  ActiveConversation,
  { scope: "session" }
>;
/** The project-scoped variant — session-less, runs in the main worktree. */
export type ProjectActiveConversation = Extract<
  ActiveConversation,
  { scope: "project" }
>;

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
export type ActiveConversationsResponse = z.infer<
  typeof activeConversationsResponseSchema
>;
