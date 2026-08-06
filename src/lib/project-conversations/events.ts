import { buildConversationCreatedEvent } from "@/lib/conversations/created-event";
import type {
  ConversationCreatedEvent,
  StoredConversationState,
} from "@/lib/conversations/schemas";

/**
 * Build the scope=project `conversation-created` SSE event. Shared by the
 * explicit create route and the first-prompt entry so both emit the same
 * real-time creation event.
 */
export function buildProjectConversationCreatedEvent(
  projectName: string,
  conversation: StoredConversationState,
): ConversationCreatedEvent {
  return buildConversationCreatedEvent({
    scope: "project",
    projectName,
    conversation,
  });
}
