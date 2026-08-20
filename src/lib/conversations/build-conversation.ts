import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
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
  /**
   * Token of the create-and-send submission this conversation is being created
   * for. Only the project create-and-send entry has one: every other site
   * already hands the requesting client the conversation id.
   */
  creationRequestId?: string;
  /**
   * The resolved profile this conversation runs under, composed and hashed
   * before the call. Resolution reads the library from disk, so it happens in
   * the caller — outside any write-queue critical section — and arrives here as
   * settled bytes.
   *
   * Omitted only by callers that are not a user-facing creation path (test
   * fixtures, and the legacy shape a pre-feature row reads back as).
   */
  profileSnapshot?: AgentProfileSnapshot | null;
  /**
   * Set at construction only by a session-derived fork, which is locked from
   * creation because the source's instructions are already in its context.
   * Every other site leaves the profile changeable until first-prompt admission.
   */
  profileLockedAt?: string | null;
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
    nameOrigin: "default",
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
    // A new conversation is free and has admitted no turns. Both are advanced
    // by whoever admits the first one — prompt admission or a collaboration
    // claim — never at creation.
    owner: null,
    turnGeneration: 0,
    // Resolved and composed by the caller before this row exists, so the
    // snapshot is durable before the conversation's first provider runtime can
    // be created (R6). A caller that supplies none leaves the row legacy —
    // no injection, no profile to change — which is the honest record of how it
    // ran.
    profileSnapshot: input.profileSnapshot ?? null,
    profileLockedAt: input.profileLockedAt ?? null,
  };

  if (input.scope === "project") {
    conversation.open = true;
    if (input.creationRequestId !== undefined) {
      conversation.creationRequestId = input.creationRequestId;
    }
  }

  return conversation;
}
