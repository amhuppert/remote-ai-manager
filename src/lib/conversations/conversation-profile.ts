import {
  formatAgentProfileRef,
  redactAgentProfileSnapshot,
  type AgentProfileSnapshot,
  type RedactedAgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import type { StoredConversationState } from "./schemas";

/**
 * The conversation-side reading of a stored profile snapshot: what the runtime
 * replays, what a read surface may render, and when the profile stops being
 * changeable. All three answers hang off the same nullability, so they live
 * together rather than being re-derived per call site.
 */

/**
 * The instruction block to append to this conversation's session instructions,
 * or null when there is nothing to inject.
 *
 * Returns the STORED bytes — it never re-renders. That is the whole point of
 * persisting `renderedInstructionBlock` verbatim (R6): a restart, a runtime
 * recreation, or a later edit to the library record must not change what a live
 * conversation is running under, and `resolvedInstructionHash` stays true to
 * what the model actually received.
 *
 * A legacy conversation (null snapshot) returns null and therefore receives no
 * profile injection on its next turn.
 */
export function conversationProfileInstructionBlock(
  conversation: StoredConversationState,
): string | null {
  return conversation.profileSnapshot?.renderedInstructionBlock ?? null;
}

/**
 * The conversation's profile identity as any read surface may carry it, or null
 * when there is none (a legacy conversation). Every projection — the public
 * aggregate, both list feeds, log fields — redacts through this one function,
 * so "what is safe to show" is answered once.
 */
export function redactedConversationProfile(conversation: {
  profileSnapshot?: AgentProfileSnapshot | null;
}): RedactedAgentProfileSnapshot | null {
  const snapshot = conversation.profileSnapshot ?? null;
  return snapshot === null ? null : redactAgentProfileSnapshot(snapshot);
}

/**
 * What a conversation's profile looks like to a reader. The `profile` variant
 * carries the REDACTED snapshot only, so a description can be rendered, logged,
 * or serialized without a separate redaction step at each surface.
 */
export type ConversationProfileDescription =
  | { kind: "legacy" }
  | {
      kind: "profile";
      /** Compact `tier:id` spelling for display. */
      ref: string;
      snapshot: RedactedAgentProfileSnapshot;
      lockedAt: string | null;
    };

export function describeConversationProfile(
  conversation: StoredConversationState,
): ConversationProfileDescription {
  const snapshot = conversation.profileSnapshot ?? null;
  if (snapshot === null) return { kind: "legacy" };
  return {
    kind: "profile",
    ref: formatAgentProfileRef({ tier: snapshot.tier, id: snapshot.id }),
    snapshot: redactAgentProfileSnapshot(snapshot),
    lockedAt: conversation.profileLockedAt,
  };
}

/**
 * Why a profile change was refused. Both reasons are terminal for the same
 * underlying rule — the conversation's profile is settled — so callers get one
 * error type and one message shape rather than two paths to reconcile.
 */
export type ConversationProfileLockReason = "locked" | "legacy";

export class ConversationProfileLockedError extends Error {
  constructor(
    readonly conversationId: string,
    readonly reason: ConversationProfileLockReason,
  ) {
    super(
      reason === "locked"
        ? `Conversation ${conversationId} has already run a turn, so its agent profile is locked. Fork it to work under a different profile.`
        : `Conversation ${conversationId} predates the agent profile library and has no profile to change. Start a new conversation to choose one.`,
    );
    this.name = "ConversationProfileLockedError";
  }
}

/**
 * Throws {@link ConversationProfileLockedError} unless the conversation's
 * profile can still be changed.
 *
 * Locked means the conversation has run a turn: providers apply instructions at
 * different points, so a mid-stream swap has no consistent cross-backend
 * meaning. A legacy conversation is refused by the same rule — it ran every one
 * of its turns with no profile, and inventing one now would make its snapshot a
 * false record of the invocation (R6.5).
 */
export function assertConversationProfileChangeAllowed(
  conversation: StoredConversationState,
): void {
  if ((conversation.profileSnapshot ?? null) === null) {
    throw new ConversationProfileLockedError(conversation.id, "legacy");
  }
  if (conversation.profileLockedAt !== null) {
    throw new ConversationProfileLockedError(conversation.id, "locked");
  }
}
