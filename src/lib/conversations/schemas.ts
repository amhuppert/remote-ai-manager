import { z } from "zod";
import {
  projectConversationTarget,
  sessionConversationTarget,
  type ConversationTarget,
} from "./conversation-target";
import { isProjectSentinel } from "./project-conversation-scope";
import type { ConversationScopeRef } from "./conversation-target";
import {
  agentBackendSchema,
  agentSessionRefSchema,
} from "@/lib/shared/schemas";
import { persistedAgentSessionRefSchema } from "@/lib/shared/session-ref-codec";
import {
  mcpOverridesSchema,
  mcpRuntimeApplicationStateSchema,
} from "@/lib/mcp/schemas";
import {
  agentCapabilityOverridesSchema,
  agentCapabilityRuntimeApplicationStateSchema,
} from "@/lib/agent-capabilities/schemas";
import { debugModeStateSchema } from "@/lib/debug-log/schemas";
import {
  messageContentBlockSchema,
  toolResultMetricsSchema,
  type MessageContentBlock,
  type ToolResultMetrics,
} from "./message-content-schemas";
import {
  pendingQueuedMessageSchema,
  queuedMessageViewSchema,
} from "./message-queue-schemas";

export {
  messageContentBlockSchema,
  toolResultMetricsSchema,
  type MessageContentBlock,
  type ToolResultMetrics,
};

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

/**
 * Anchor tying an extracted claim or rendered unit to exact transcript
 * coordinates. Two coordinate systems are carried deliberately (see
 * docs/design/conversation-compaction/README.md §3): `messageIndex`/`messageId`
 * address the merged visible-message array (UI navigation), while
 * `seqStart`/`seqEnd` are raw JSONL line indexes (slicing, staleness, delta).
 */
export const sourceRefSchema = z.object({
  messageIndex: z.number().int(),
  messageId: z.string().nullable(),
  seqStart: z.number().int(),
  seqEnd: z.number().int(),
  quote: z.string().optional(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const transcriptMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "notice"]),
  content: z.array(messageContentBlockSchema),
  timestamp: z.string().nullable(),
  model: z.string().optional(),
  effort: z.string().optional(),
  origin: transcriptMessageOriginSchema.optional(),
});

/** Parsed transcript message */
export interface TranscriptMessage {
  /** Stable visible-message id when the writer can provide one. */
  id?: string;
  /** Message role. `notice` marks a CC-authored informational entry. */
  role: "user" | "assistant" | "notice";
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

/**
 * A transcript message stamped with its append sequence number — the wire
 * shape of the messages endpoints, letting SSE patches address rows by `seq`.
 */
export const stampedTranscriptMessageSchema = transcriptMessageSchema.extend({
  seq: z.number().int().nonnegative(),
});

// AskUserQuestion schemas (defined before conversationStateSchema which references them)
const askQuestionTradeoffSchema = z.object({
  pro: z.string().optional(),
  con: z.string().optional(),
});

const askQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().default(false),
  tradeoff: askQuestionTradeoffSchema.optional(),
});

export const askQuestionItemSchema = z.object({
  // Optional: the agent tool does not require it. The server fills a stable
  // index-based fallback (q.id ?? String(index)) before persist/broadcast so
  // answers, navigation, and the status rail key off it instead of question
  // text, while legacy persisted rows without an id still decode cleanly.
  id: z.string().min(1).optional(),
  question: z.string(),
  header: z.string().optional(),
  // Free prose expanding on the question (implications & trade-offs). Rendered
  // in the panel's context disclosure through the canonical `CompactMarkdown`
  // adapter (full GitHub Flavored Markdown; raw HTML shown as text).
  context: z.string().optional(),
  options: z.array(askQuestionOptionSchema),
  multiSelect: z.boolean().default(false),
  required: z.boolean().default(true),
  allowNote: z.boolean().default(true),
});
export type AskQuestionItem = z.infer<typeof askQuestionItemSchema>;

export const forkedFromSchema = z
  .object({
    sourceConversationId: z.string(),
    messageIndex: z.number().int().min(0),
    sourceBackend: agentBackendSchema.nullable().optional(),
    // Null when the fork is not derived from the source SDK session
    // (e.g., user fork at index 0 — "edit and start over"). Decodes leniently:
    // this schema sits directly on the persisted `forked_from` column, where
    // legacy and shadow-superset ref shapes coexist (see session-ref-codec).
    sourceBackendRef: persistedAgentSessionRefSchema.nullable().optional(),
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

/**
 * Graph-workflow lane conversations — the autonomous implementer and
 * context-validator roles. Lane conversations are workflow-managed: their
 * composers only mount while an approval gate or parked question is open,
 * and lane-ineligible commands (/ticket) are hidden and server-rejected.
 */
export function isWorkflowLaneRole(role: ConversationRole): boolean {
  return role === "iteration" || role === "validator";
}

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
  agentBackend: agentBackendSchema.default("claude"),
  backendRef: agentSessionRefSchema.nullable().default(null),
  mcpOverrides: mcpOverridesSchema.optional(),
  mcpRuntime: mcpRuntimeApplicationStateSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
  agentCapabilitiesRuntime:
    agentCapabilityRuntimeApplicationStateSchema.optional(),
  // Durable per-conversation queue of follow-up messages awaiting delivery.
  // `.default([])` migrates conversations stored before this field existed,
  // so no data backfill is required.
  pendingQueue: z.array(pendingQueuedMessageSchema).default([]),
  // Latest session-alignment charter version a turn in this conversation ran
  // with. Drives stale detection in the alignment header chip; null until the
  // conversation has run a turn under an active charter. `.default(null)`
  // decodes conversations persisted before this field existed.
  lastSeenAlignmentVersion: z.number().int().nullable().default(null),
  // Agent-facing notices queued while the conversation has no live backend
  // session (e.g. "your background tasks died with the session"). Drained
  // into the next runtime's session instructions and cleared. `.default([])`
  // decodes conversations persisted before this field existed.
  pendingAgentNotices: z.array(z.string()).default([]),
});
export type ConversationState = z.infer<typeof conversationStateSchema>;

// ============================================================
// Cross-Project Conversation List (addressable conversations)
// ============================================================

// Simplified projection of a conversation's compaction state advertised on
// `#` references (design §12.4): "none" when no completed
// conversation_compaction artifact exists, otherwise fresh/stale derived from
// the live transcript position vs the artifact's covered range.
export const conversationCompactStatusSchema = z.enum([
  "fresh",
  "stale",
  "none",
]);
export type ConversationCompactStatus = z.infer<
  typeof conversationCompactStatusSchema
>;

/**
 * Everything a listed conversation carries regardless of scope. `sessionName`
 * lives only on the session variant below: this list is a public API response
 * (`GET /api/conversations/all`), and a single `sessionName: string` field is
 * exactly what let the internal `__project__` sentinel occupy a public position
 * (R1.3/D1). The project variant has no field for it to occupy.
 */
const conversationListItemFieldsSchema = z.object({
  projectName: z.string(),
  projectPath: z.string(),
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
  // Compaction advertisement — present only for conversations with a
  // completed conversation_compaction artifact (design §12.4).
  compactArtifactId: z.string().optional(),
  compactStatus: conversationCompactStatusSchema.optional(),
  /** Covered seq range formatted "<start>..<end>", e.g. "0..421". */
  compactCoveredSeq: z.string().optional(),
  compactCreatedAt: z.string().optional(),
});

export const conversationListItemSchema = z.discriminatedUnion("scope", [
  conversationListItemFieldsSchema.extend({
    scope: z.literal("session"),
    sessionName: z
      .string()
      .min(1)
      .refine((name) => !isProjectSentinel(name), {
        message:
          "a project conversation is listed with scope \"project\", not a sentinel session name",
      }),
  }),
  conversationListItemFieldsSchema.extend({ scope: z.literal("project") }),
]);
export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

/**
 * The session-scoped variant. Consumers whose capability is session-only (the
 * document-comment workflow, session-scoped attachments) take this type, so the
 * compiler makes them filter project conversations out rather than reading a
 * `sessionName` that does not exist.
 */
export type SessionConversationListItem = Extract<
  ConversationListItem,
  { scope: "session" }
>;

/**
 * The listed conversation's public addressing target — the one supported way to
 * turn a list item into a URL, query key, or label.
 */
export function conversationListItemTarget(
  item: ConversationListItem,
): ConversationTarget {
  return item.scope === "session"
    ? sessionConversationTarget(
        item.projectName,
        item.sessionName,
        item.conversationId,
      )
    : projectConversationTarget(item.projectName, item.conversationId);
}

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
const conversationRefWireFieldsSchema = z.object({
  "project-name": z.string().min(1),
  "project-path": z.string().min(1),
  "worktree-path": z.string().min(1),
  "conversation-id": z.string().min(1),
  "conversation-name": z.string(),
  backend: agentBackendSchema,
  "backend-ref": z.string(),
  "debug-log-path": z.string(),
  status: conversationStatusSchema,
  "last-activity-at": z.string(),
  // Compaction advertisement (design §12.4). Refs emitted without a completed
  // conversation compaction carry compact-status="none" alone; older refs
  // predate these attributes entirely.
  "compact-artifact-id": z.string().optional(),
  "compact-status": conversationCompactStatusSchema.optional(),
  "compact-covered-seq": z.string().optional(),
  "compact-created-at": z.string().optional(),
  // Ready-to-run cctl commands for the reading agent — cctl resolves the owning
  // project/session from the id, so these carry no flags. read-command is
  // always emitted; compaction-command only when a compaction exists. Older
  // refs predate both.
  "read-command": z.string().optional(),
  "compaction-command": z.string().optional(),
});

/**
 * The reference wire contract, discriminated on scope (D1).
 *
 * `scope` is required — a tolerated default would be a backward-compatibility
 * shim, which needs explicit approval under the charter, and would reintroduce
 * the very defect D1 closes. The project variant carries NO `session-name`, so
 * an inconsistent combination (project scope naming a session, or session scope
 * naming the internal sentinel) fails validation instead of round-tripping.
 */
export const conversationRefAttrsSchema = z.discriminatedUnion("scope", [
  conversationRefWireFieldsSchema.extend({
    scope: z.literal("session"),
    "session-name": z
      .string()
      .min(1)
      .refine((name) => !isProjectSentinel(name), {
        message:
          "project conversations are referenced with scope=\"project\", not a session name",
      }),
  }),
  conversationRefWireFieldsSchema.extend({
    scope: z.literal("project"),
    // A project conversation has no owning session, so the attribute must be
    // absent rather than empty — there is no field for a name to occupy. A
    // present value (empty, a real name, or the sentinel) fails validation.
    "session-name": z.undefined().optional(),
  }),
]);
export type ConversationRefAttrs = z.infer<typeof conversationRefAttrsSchema>;

/**
 * The camelCase counterpart of the wire attributes: what the prompt editor's
 * `conversationMention` node holds and what the `#` picker inserts. Absent
 * values are empty strings (the node persists every attribute as a string).
 * Derived from Zod rather than restated, so the two cannot drift.
 */
export const conversationMentionFieldsSchema = z.object({
  projectName: z.string(),
  projectPath: z.string(),
  worktreePath: z.string(),
  conversationId: z.string(),
  /** Empty string when the source conversation had no name. */
  conversationName: z.string(),
  backend: agentBackendSchema,
  /** Empty string when the source conversation has no backend session yet. */
  backendRef: z.string(),
  /** Not carried on the wire — the serializer omits it. */
  transcriptPath: z.string(),
  debugLogPath: z.string(),
  status: conversationStatusSchema,
  lastActivityAt: z.string(),
  /** Empty string when no completed conversation compaction exists. */
  compactArtifactId: z.string(),
  compactStatus: conversationCompactStatusSchema,
  /** Covered seq range "<start>..<end>"; empty string when no compaction. */
  compactCoveredSeq: z.string(),
  /** ISO timestamp; empty string when no compaction. */
  compactCreatedAt: z.string(),
});
export type ConversationMentionFields = z.infer<
  typeof conversationMentionFieldsSchema
>;

/**
 * Mention/builder attributes, scope-discriminated by intersection with the
 * shared `ConversationScopeRef` union: the project variant has no `sessionName`
 * key at all (D1 / R1.3).
 */
export type ConversationMentionAttrs = ConversationMentionFields &
  ConversationScopeRef;

// Attributes of an inline `<message-ref ... />` XML tag — a reference to one
// message of a conversation, copied from the message's action bar and emitted
// by the prompt-editor serializer. Hyphenated keys match the wire format.
export const messageRefAttrsSchema = z.object({
  "project-name": z.string().min(1),
  // Absent for project-scoped conversations that have no owning session.
  "session-name": z.string().min(1).optional(),
  "conversation-id": z.string().min(1),
  "conversation-name": z.string().optional(),
  // 0-based index into the conversation's visible-message array — the
  // coordinate `cctl conversation read --message N` addresses.
  "message-index": z.string().regex(/^\d+$/),
  role: z.enum(["user", "assistant", "notice"]),
  timestamp: z.string().optional(),
  model: z.string().optional(),
  // Whether a completed message_compaction artifact covers this message; the
  // compact-* details and compaction-command are present only when "true".
  compacted: z.enum(["true", "false"]).optional(),
  "compact-artifact-id": z.string().optional(),
  "compact-created-at": z.string().optional(),
  // Ready-to-run cctl commands for the reading agent — cctl resolves the
  // owning project/session from the conversation id, so these carry no flags.
  "read-command": z.string().optional(),
  "compaction-command": z.string().optional(),
});
export type MessageRefAttrs = z.infer<typeof messageRefAttrsSchema>;

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

// A single answer to one AskUserQuestion item. Carries the user's selected
// option labels plus an optional clarifying note, so a selection and free text
// travel together instead of "Other" replacing the choice.
export const askQuestionAnswerSchema = z.object({
  // Chosen option labels. A "Something else" free-text answer is pushed in
  // verbatim. Empty when the question was skipped.
  selected: z.array(z.string()),
  // Clarifying note sent alongside the selection; null when empty.
  note: z.string().nullable(),
  skipped: z.boolean(),
  // Echoed question text, so the agent can map an answer without re-deriving
  // it from the (now id-keyed) record.
  question: z.string().optional(),
});
export type AskQuestionAnswer = z.infer<typeof askQuestionAnswerSchema>;

export const answerQuestionRequestSchema = z.object({
  questionId: z.string(),
  // Keyed by question id. Zod v4 requires the explicit key schema as the first
  // arg — z.record(value) alone would treat the value schema as the key schema.
  answers: z.record(z.string(), askQuestionAnswerSchema),
});
export type AnswerQuestionRequest = z.infer<typeof answerQuestionRequestSchema>;

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
export const sessionEventIdentity = {
  scope: z.literal("session"),
  projectName: z.string(),
  sessionName: z.string(),
};
export const projectEventIdentity = {
  scope: z.literal("project"),
  projectName: z.string(),
};

export const conversationStatusEventSchema = z.discriminatedUnion("scope", [
  z.object({
    type: z.literal("conversation-status"),
    ...sessionEventIdentity,
    // Non-empty: the lifecycle projection uses conversationId as the StatusBus
    // scopeId, which the envelope schema requires to be non-empty.
    conversationId: z.string().min(1),
    status: z.enum(["running", "awaiting", "waiting_for_input"]),
    error: z.string().optional(),
  }),
  z
    .object({
      type: z.literal("conversation-status"),
      ...projectEventIdentity,
      conversationId: z.string().min(1),
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
    // Non-empty: the lifecycle projection uses conversationId as the StatusBus
    // scopeId, which the envelope schema requires to be non-empty.
    conversationId: z.string().min(1),
    questionId: z.string(),
    questions: z.array(askQuestionItemSchema),
  }),
  z
    .object({
      type: z.literal("ask-question"),
      ...projectEventIdentity,
      conversationId: z.string().min(1),
      questionId: z.string(),
      questions: z.array(askQuestionItemSchema),
    })
    .strict(),
]);
export type AskQuestionEvent = z.infer<typeof askQuestionEventSchema>;

export const messageQueuedEventSchema = z.object({
  type: z.literal("message-queued"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  text: z.string(),
  // The durable queued message projection. Optional so a producer that has not
  // yet built the projection still validates without it.
  message: queuedMessageViewSchema.optional(),
});
export type MessageQueuedEvent = z.infer<typeof messageQueuedEventSchema>;

export const messageQueueUpdatedEventSchema = z.object({
  type: z.literal("message-queue-updated"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  message: queuedMessageViewSchema,
});
export type MessageQueueUpdatedEvent = z.infer<
  typeof messageQueueUpdatedEventSchema
>;
