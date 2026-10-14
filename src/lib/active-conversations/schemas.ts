import { z } from "zod";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import {
  askQuestionItemSchema,
  conversationBackgroundActivitySchema,
} from "@/lib/conversations/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { redactedAgentProfileSnapshotSchema } from "@/lib/agent-profiles/schemas";

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
  // Sidebar rows carry archival state; the active-only feed omits it.
  archived: z.boolean().optional(),
  // Which agent profile the conversation runs under, redacted (R6.3): identity
  // and provenance hashes only. Null for a legacy conversation. The row has no
  // key instruction text could occupy; optionality only spares the many sidebar
  // fixtures from restating a field they do not exercise, and the wire suite
  // asserts the production assembler sets it.
  redactedProfileSnapshot: redactedAgentProfileSnapshotSchema
    .nullable()
    .optional(),
  // Live harness background work (a Workflow-tool run, a backgrounded shell, a
  // subagent) that keeps running between turns. Read from the in-memory
  // background-activity channel at assembly time and patched live by the
  // `conversation-background-activity` SSE event; null when nothing is running.
  backgroundActivity: conversationBackgroundActivitySchema
    .nullable()
    .default(null),
  // Whether custody holds the runtime between turns (design C5b §5): background
  // work Stop ends, which may hold with no visible task. Read from the core at
  // assembly time and patched live by the `conversation-custody` SSE event;
  // never persisted. Optionality only spares the many row fixtures from
  // restating it; the assembler always sets it.
  custody: z.boolean().optional(),
};

export const activeConversationSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("session"),
    ...activeConversationSharedFields,
    // This list is a public API response body (R1.3): a project conversation
    // is a `scope: "project"` row, so a session row naming the internal store
    // sentinel is a producer leaking a storage key as a session identity.
    sessionName: z.string().refine((name) => !isProjectSentinel(name), {
      message:
        'a project conversation is listed with scope "project", not a sentinel session name',
    }),
    branchName: z.string().nullable(),
  }),
  z.object({
    scope: z.literal("project"),
    ...activeConversationSharedFields,
    open: z.boolean(),
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
export type ActiveCollaborationExecution = z.infer<
  typeof activeCollaborationExecutionSchema
>;

export const activeConversationsResponseSchema = z.object({
  conversations: z.array(activeConversationSchema),
  activeCollaborationExecutions: z
    .array(activeCollaborationExecutionSchema)
    .default([]),
});
export type ActiveConversationsResponse = z.infer<
  typeof activeConversationsResponseSchema
>;
