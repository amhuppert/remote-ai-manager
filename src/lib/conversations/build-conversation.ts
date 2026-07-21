import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type {
  ConversationRole,
  ConversationScope,
  ConversationState,
  ForkedFrom,
} from "./schemas";

/**
 * The fields that actually vary across the five conversation-construction
 * sites (new session's initial conversation, `createConversation`,
 * `forkConversation`, `finalizeInitialization`, `createProjectConversation`).
 * Everything else a new conversation carries is a fixed initial default owned
 * by {@link buildConversation}; a caller cannot accidentally diverge on it.
 */
export interface BuildConversationInput {
  id: string;
  scope: ConversationScope;
  name: string;
  /** ISO timestamp used for both `createdAt` and `lastActivityAt`. */
  createdAt: string;
  agentBackend: AgentBackendId;
  /** Fork sites seed a transcript file; fresh conversations start with none. */
  transcriptPath?: string | null;
  /** Fork sites may carry over the drafted prompt text. */
  pendingPromptText?: string | null;
  forkedFrom?: ForkedFrom | null;
  role?: ConversationRole;
  /** Fork sites carry over the source's resume handle. */
  backendRef?: AgentSessionRef | null;
}

/**
 * The single owner of the initial `ConversationState` shape. Every
 * construction site passes only what genuinely differs (id, scope, name,
 * timestamp, backend, and the fork-carried handoff fields); this module fills
 * every other field with its canonical new-conversation default so a field
 * added to `ConversationState` is defaulted in exactly one place instead of
 * five.
 *
 * Scope is the one policy the shape branches on: project conversations model an
 * open/closed tab (`open: true` on creation), while session conversations never
 * carry `open`.
 */
export function buildConversation(
  input: BuildConversationInput,
): ConversationState {
  const conversation: ConversationState = {
    id: input.id,
    scope: input.scope,
    name: input.name,
    transcriptPath: input.transcriptPath ?? null,
    status: "new",
    promptCount: 0,
    createdAt: input.createdAt,
    lastActivityAt: input.createdAt,
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: input.pendingPromptText ?? null,
    forkedFrom: input.forkedFrom ?? null,
    role: input.role ?? null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: input.agentBackend,
    backendRef: input.backendRef ?? null,
    unread: false,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    pendingQueue: [],
  };

  if (input.scope === "project") {
    conversation.open = true;
  }

  return conversation;
}
