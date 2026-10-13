import { isEligibleOwner } from "@/lib/conversations/owner-eligibility";
import type { PublicConversationState } from "@/lib/conversations/schemas";
import type { OwnerChoice } from "./components/template/LaunchDialog";

/** What the owner list reads of a session's conversation. */
export type OwnerCandidate = Pick<
  PublicConversationState,
  | "id"
  | "name"
  | "status"
  | "role"
  | "owner"
  | "archived"
  | "agentBackend"
  | "lastActivityAt"
>;

/**
 * The conversations a person may make a run's owner, most recently active
 * first: the server's eligibility rule, applied to the session's list. The
 * launch checks it again when the run is recorded.
 */
export function ownerChoicesOf(
  conversations: readonly OwnerCandidate[],
  sessionArchived: boolean,
): OwnerChoice[] {
  return conversations
    .filter((conversation) => isEligibleOwner(conversation, sessionArchived))
    .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .map((conversation) => ({
      conversationId: conversation.id,
      title: conversation.name ?? "Untitled conversation",
      backend: conversation.agentBackend,
      busy: conversation.status === "running",
    }));
}
