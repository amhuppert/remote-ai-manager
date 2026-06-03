import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { agentSessionRefSchema } from "@/lib/agent-backends/schemas";
import {
  mcpOverridesSchema,
  mcpRuntimeApplicationStateSchema,
} from "@/lib/mcp/schemas";
import {
  agentCapabilityOverridesSchema,
  agentCapabilityRuntimeApplicationStateSchema,
} from "@/lib/agent-capabilities/schemas";
import { debugModeStateSchema } from "@/lib/debug-log/schemas";

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

export const toolResultMetricsSchema = z.object({
  lineCount: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  matchCount: z.number().int().nonnegative().optional(),
  byteCount: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
});
export type ToolResultMetrics = z.infer<typeof toolResultMetricsSchema>;

// Forward reference: debugModePhaseSchema is defined in @/lib/debug-log/schemas.
// We inline its values here so messageContentBlockSchema can be defined first
// without a hoisting cycle.
const debugModePhaseLiterals = z.enum([
  "hypothesizing",
  "awaiting_reproduction",
  "analyzing_evidence",
  "awaiting_verification",
  "cleanup_instrumentation",
]);

export const messageContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string().optional(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.string().optional(),
    isError: z.boolean().optional(),
    metrics: toolResultMetricsSchema.optional(),
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
  z.object({
    type: z.literal("image_marker"),
    index: z.number().int().positive(),
    mediaType: z.string(),
    imagePath: z.string(),
  }),
  // Structured debug-mode output (hypothesis list, evidence analysis, fix
  // result, cleanup result). The payload shape varies per phase; the renderer
  // dispatches on `phase` and gracefully degrades when fields are missing
  // (e.g., Codex schema-divergent reply).
  z.object({
    type: z.literal("debug_structured"),
    phase: debugModePhaseLiterals,
    payload: z.unknown(),
  }),
]);
export type MessageContentBlock = z.infer<typeof messageContentBlockSchema>;

export const transcriptMessageOriginSchema = z.object({
  source: z.enum(["user", "workflow"]),
  workflow: z
    .object({
      executionId: z.string(),
      nodeId: z.string(),
      iterationIndex: z.number().int().nonnegative(),
    })
    .optional(),
});
export type TranscriptMessageOrigin = z.infer<
  typeof transcriptMessageOriginSchema
>;

export const transcriptMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(messageContentBlockSchema),
  timestamp: z.string().nullable(),
  model: z.string().optional(),
  effort: z.string().optional(),
  origin: transcriptMessageOriginSchema.optional(),
});

/** Parsed transcript message */
export interface TranscriptMessage {
  /** Message role */
  role: "user" | "assistant";
  /** Message content blocks (text, tool_use, tool_result) */
  content: MessageContentBlock[];
  /** ISO 8601 timestamp if available */
  timestamp: string | null;
  /** Model used for this turn (e.g., "opus", "sonnet") */
  model?: string;
  /** Reasoning effort level used for this turn */
  effort?: string;
  /** Where this message originated. Absent on legacy transcripts. */
  origin?: TranscriptMessageOrigin;
}

// AskUserQuestion schemas (defined before conversationStateSchema which references them)
const askQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

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
    messageIndex: z.number().int().min(0),
    sourceBackend: agentBackendSchema.nullable().optional(),
    // Null when the fork is not derived from the source SDK session
    // (e.g., user fork at index 0 — "edit and start over").
    sourceBackendRef: agentSessionRefSchema.nullable().optional(),
    forkLocator: z.string().nullable().optional(),
    forkMode: z.enum(["native", "synthetic"]).nullable().default(null),
  })
  .nullable()
  .default(null);
export type ForkedFrom = z.infer<typeof forkedFromSchema>;

export const conversationRoleSchema = z
  .enum(["initialization", "iteration", "validator", "planner"])
  .nullable()
  .default(null);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

// Distinguishes user-initiated turns from workflow-driven background turns
// (e.g. smart-merge's validation-fix task_run, graph-workflow's autonomous
// implementer). Null when no turn is active. The conversation panel uses this
// to suppress the Stop button when the agent is busy on behalf of a workflow,
// since stopping would abort that workflow rather than a user prompt.
export const activeTurnSourceSchema = z
  .enum(["user", "workflow"])
  .nullable()
  .default(null);
export type ActiveTurnSource = z.infer<typeof activeTurnSourceSchema>;

// ============================================================
// Conversation State
// ============================================================

// Restricts conversationId to filesystem-safe characters. The id is used as a
// directory name for transcripts and debug logs, so any character that could
// enable path traversal or escape the parent directory must be rejected at
// the trust boundary. UUIDs and underscored/dashed ids both fit this regex.
const conversationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

// Explicit scope discriminator distinguishing session-owned conversations from
// session-less project conversations. Defaults to "session" so conversation
// rows persisted before this field existed decode natively (no migration).
export const conversationScopeSchema = z
  .enum(["session", "project"])
  .default("session");
export type ConversationScope = z.infer<typeof conversationScopeSchema>;

export const conversationStateSchema = z.object({
  id: conversationIdSchema,
  scope: conversationScopeSchema,
  name: z.string().nullable().default(null),
  transcriptPath: z.string().nullable(),
  status: conversationStatusSchema,
  promptCount: z.number(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  source: z.enum(["cc", "imported"]).default("cc"),
  summary: z.string().nullable().default(null),
  archived: z.boolean().default(false),
  // Project conversations model an open/closed tab state independent of
  // archiving (`closed = open === false && !archived`). Optional because
  // session conversations have no such concept — they never persist `open`.
  open: z.boolean().optional(),
  // Back-link a project conversation persists to the sessions it spawned from
  // its inline spawn cards. Optional+PLC-only (like `open`): session
  // conversations never carry it, and the project-conversations repo provides
  // an explicit `[]` on decode so a populated/legacy PLC always reads an array.
  spawnedSessionIds: z.array(z.string()).optional(),
  totalCostUsd: z.number().nullable().default(null),
  totalDurationMs: z.number().nullable().default(null),
  totalTurns: z.number().nullable().default(null),
  pendingQuestionId: z.string().nullable().default(null),
  pendingQuestions: z.array(askQuestionItemSchema).nullable().default(null),
  pendingPromptText: z.string().nullable().default(null),
  // True when the agent finished a user-initiated turn and the user has not
  // yet opened or acknowledged the conversation. Drives the "Finished —
  // unread" sidebar pin alongside pendingQuestionId. Cleared on open, on the
  // explicit acknowledge endpoint, on answer, and on the next user-initiated
  // prompt.
  unread: z.boolean().default(false),
  forkedFrom: forkedFromSchema,
  role: conversationRoleSchema,
  activeTurnSource: activeTurnSourceSchema,
  contextTokens: z.number().nullable().default(null),
  contextWindowMax: z.number().nullable().default(null),
  debugMode: debugModeStateSchema.nullable().default(null),
  machineSnapshot: z.unknown().nullable().default(null),
  agentBackend: agentBackendSchema.default("claude"),
  backendRef: agentSessionRefSchema.nullable().default(null),
  mcpOverrides: mcpOverridesSchema.optional(),
  mcpRuntime: mcpRuntimeApplicationStateSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
  agentCapabilitiesRuntime:
    agentCapabilityRuntimeApplicationStateSchema.optional(),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

// ============================================================
// Cross-Project Conversation List (addressable conversations)
// ============================================================

export const conversationListItemSchema = z.object({
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  worktreePath: z.string(),
  conversationId: z.string(),
  conversationName: z.string().nullable(),
  summary: z.string().nullable(),
  firstPromptSnippet: z.string().nullable(),
  backend: agentBackendSchema,
  backendRef: agentSessionRefSchema.nullable(),
  transcriptPath: z.string().nullable(),
  debugLogPath: z.string().nullable(),
  status: conversationStatusSchema,
  lastActivityAt: z.string(),
  archived: z.boolean(),
});
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

export const allConversationsResponseSchema = z.object({
  items: z.array(conversationListItemSchema),
  totalCount: z.number().int().nonnegative(),
});
export type AllConversationsResponse = z.infer<
  typeof allConversationsResponseSchema
>;

// Attributes of an inline `<conversation-ref ... />` XML tag emitted by the
// prompt-editor serializer and parsed by the message renderer. Hyphenated
// keys match the wire-format attribute names exactly.
export const conversationRefAttrsSchema = z.object({
  "project-name": z.string().min(1),
  "project-path": z.string().min(1),
  "session-name": z.string().min(1),
  "worktree-path": z.string().min(1),
  "conversation-id": z.string().min(1),
  "conversation-name": z.string(),
  backend: agentBackendSchema,
  "backend-ref": z.string(),
  "transcript-path": z.string(),
  "debug-log-path": z.string(),
  status: conversationStatusSchema,
  "last-activity-at": z.string(),
});
export type ConversationRefAttrs = z.infer<typeof conversationRefAttrsSchema>;

// ============================================================
// API Request Schemas
// ============================================================

export const renameConversationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const forkRequestSchema = z.object({
  messageIndex: z.number().int().min(0),
});

export const forkResponseSchema = z.object({
  conversationId: z.string(),
  name: z.string(),
  forkMode: z.enum(["native", "synthetic"]).nullable(),
});

export const answerQuestionRequestSchema = z.object({
  questionId: z.string(),
  answers: z.record(z.string(), z.string()),
});

// ============================================================
// SSE Event Schemas (scope-discriminated)
// ============================================================

// Each conversation SSE event is a `scope`-discriminated union. The session
// variant is wire-compatible with the pre-scope payload — it still carries
// `sessionName` — so existing producers/consumers behave unchanged once they
// stamp `scope:"session"`. The project variant carries `projectName` (plus the
// event's identity payload) and omits `sessionName`: a session-less project
// conversation has no owning session. Project variants are `.strict()` so a
// stray `sessionName` is rejected rather than silently stripped.
const sessionEventIdentity = {
  scope: z.literal("session"),
  projectName: z.string(),
  sessionName: z.string(),
};
const projectEventIdentity = {
  scope: z.literal("project"),
  projectName: z.string(),
};

export const conversationStatusEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("conversation-status"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    status: z.enum(["running", "awaiting", "waiting_for_input"]),
    error: z.string().optional(),
  }),
  z
    .object({
      type: z.literal("conversation-status"),
      ...projectEventIdentity,
      conversationId: z.string(),
      status: z.enum(["running", "awaiting", "waiting_for_input"]),
      error: z.string().optional(),
    })
    .strict(),
]);
export type ConversationStatusEvent = z.infer<
  typeof conversationStatusEventSchema
>;

export const messageAppendedEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("message-appended"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    seq: z.number().int().nonnegative(),
    message: transcriptMessageSchema,
  }),
  z
    .object({
      type: z.literal("message-appended"),
      ...projectEventIdentity,
      conversationId: z.string(),
      seq: z.number().int().nonnegative(),
      message: transcriptMessageSchema,
    })
    .strict(),
]);
export type MessageAppendedEvent = z.infer<typeof messageAppendedEventSchema>;

export const messageUpdatedEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("message-updated"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    seq: z.number().int().nonnegative(),
    message: transcriptMessageSchema,
  }),
  z
    .object({
      type: z.literal("message-updated"),
      ...projectEventIdentity,
      conversationId: z.string(),
      seq: z.number().int().nonnegative(),
      message: transcriptMessageSchema,
    })
    .strict(),
]);
export type MessageUpdatedEvent = z.infer<typeof messageUpdatedEventSchema>;

export const conversationCreatedEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("conversation-created"),
    ...sessionEventIdentity,
    conversation: conversationStateSchema,
  }),
  z
    .object({
      type: z.literal("conversation-created"),
      ...projectEventIdentity,
      conversation: conversationStateSchema,
    })
    .strict(),
]);
export type ConversationCreatedEvent = z.infer<
  typeof conversationCreatedEventSchema
>;

export const conversationRenamedEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("conversation-renamed"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    name: z.string().nullable(),
  }),
  z
    .object({
      type: z.literal("conversation-renamed"),
      ...projectEventIdentity,
      conversationId: z.string(),
      name: z.string().nullable(),
    })
    .strict(),
]);
export type ConversationRenamedEvent = z.infer<
  typeof conversationRenamedEventSchema
>;

export const conversationArchivedEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("conversation-archived"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    archived: z.boolean(),
  }),
  z
    .object({
      type: z.literal("conversation-archived"),
      ...projectEventIdentity,
      conversationId: z.string(),
      archived: z.boolean(),
    })
    .strict(),
]);
export type ConversationArchivedEvent = z.infer<
  typeof conversationArchivedEventSchema
>;

export const conversationUnreadEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("conversation-unread"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    unread: z.boolean(),
  }),
  z
    .object({
      type: z.literal("conversation-unread"),
      ...projectEventIdentity,
      conversationId: z.string(),
      unread: z.boolean(),
    })
    .strict(),
]);
export type ConversationUnreadEvent = z.infer<
  typeof conversationUnreadEventSchema
>;

// Project-only lifecycle event: a project conversation gained or lost its open
// tab (closed/reopened). Session conversations do not model open/closed as a
// first-class tab state, so this event is scoped to "project" only; it can be
// widened to a scope union later if sessions adopt the same concept.
export const conversationOpenEventSchema = z.object({
  type: z.literal("conversation-open"),
  scope: z.literal("project"),
  projectName: z.string(),
  conversationId: z.string(),
  open: z.boolean(),
});
export type ConversationOpenEvent = z.infer<typeof conversationOpenEventSchema>;

// ============================================================
// AskUserQuestion Event Schemas (scope-discriminated)
// ============================================================

export const askQuestionEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("ask-question"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    questionId: z.string(),
    questions: z.array(askQuestionItemSchema),
  }),
  z
    .object({
      type: z.literal("ask-question"),
      ...projectEventIdentity,
      conversationId: z.string(),
      questionId: z.string(),
      questions: z.array(askQuestionItemSchema),
    })
    .strict(),
]);
export type AskQuestionEvent = z.infer<typeof askQuestionEventSchema>;

export const messageQueuedEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("message-queued"),
    ...sessionEventIdentity,
    conversationId: z.string(),
    text: z.string(),
  }),
  z
    .object({
      type: z.literal("message-queued"),
      ...projectEventIdentity,
      conversationId: z.string(),
      text: z.string(),
    })
    .strict(),
]);
export type MessageQueuedEvent = z.infer<typeof messageQueuedEventSchema>;
