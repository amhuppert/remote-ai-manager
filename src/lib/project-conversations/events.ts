import {
  conversationCreatedEventSchema,
  type ConversationCreatedEvent,
  type ConversationState,
} from "@/lib/conversations/schemas";

/**
 * Build the scope=project `conversation-created` SSE event. Shared by the
 * explicit create route and the first-prompt entry so both emit the same
 * real-time creation event.
 */
export function buildProjectConversationCreatedEvent(
  projectName: string,
  conversation: ConversationState,
): ConversationCreatedEvent {
  return conversationCreatedEventSchema.parse({
    type: "conversation-created",
    scope: "project",
    projectName,
    conversation,
  });
}
