/**
 * Whether a conversation can own work that reports to it by waking it: a run's
 * owner, or a subscription's recipient. Browser-safe, so the server's rule and
 * the owner choices a launch offers are one predicate.
 */
import {
  isOrdinaryConversationRole,
  type ConversationOwner,
  type ConversationRole,
} from "./schemas";

/** What a conversation's own row says about whether work may report to it. */
export interface OwnerEligibilityFacts {
  role: ConversationRole;
  owner: ConversationOwner | null;
  archived: boolean;
}

/**
 * An ordinary conversation that no other execution owns, with neither it nor
 * its session archived: a seat, an owned or an archived conversation would
 * never be woken by what reports to it.
 */
export function isEligibleOwner(
  conversation: OwnerEligibilityFacts,
  sessionArchived: boolean,
): boolean {
  return (
    !sessionArchived &&
    !conversation.archived &&
    conversation.owner === null &&
    isOrdinaryConversationRole(conversation.role)
  );
}
