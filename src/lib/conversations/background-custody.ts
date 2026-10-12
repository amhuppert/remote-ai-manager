import { createLogger } from "@/lib/logging";
import {
  publishEvent,
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import { conversationEventScopeFields } from "./project-conversation-scope";
import { conversationCustodyEventSchema } from "./schemas";

const logger = createLogger("background-custody");

/**
 * Tells clients that custody of a conversation's runtime began or ended
 * (design C5b §5): background work that Stop ends, which may hold with no
 * visible task, such as a continuation or an unanswered message. Best effort:
 * custody never fails because a client could not be told, and a reconnecting
 * client reads it again from the active-conversations feed.
 */
export function publishConversationCustody(
  input: {
    projectName: string;
    /** Store-level session name; the project sentinel selects the project scope. */
    sessionName: string;
    conversationId: string;
    custody: boolean;
  },
  publish: PublishFn = publishEvent,
): void {
  publishEventBestEffort({
    publish,
    logger,
    failureEvent: "conversation_custody.publish_failed",
    context: { conversationId: input.conversationId, custody: input.custody },
    build: () =>
      conversationCustodyEventSchema.parse({
        type: "conversation-custody",
        ...conversationEventScopeFields(
          input.projectName,
          input.sessionName,
          input.conversationId,
        ),
        custody: input.custody,
      }),
  });
}
