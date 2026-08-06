import {
  conversationCreatedEventSchema,
  toPublicConversationState,
  type ConversationCreatedEvent,
  type StoredConversationState,
} from "./schemas";

/**
 * The one way to build a `conversation-created` frame.
 *
 * The payload is a whole conversation, so this is the SSE event most able to
 * leak a profile's instruction text — and `publicConversationStateSchema` is
 * `.strict()`, so a producer that forgets to project does not leak, it throws,
 * and the frame silently never reaches the client. Neither outcome is
 * acceptable, and a `.parse()` call takes `unknown`, so the compiler cannot
 * catch the omission at the producer.
 *
 * Taking the STORED conversation and projecting here removes the choice: every
 * producer (session route, project route, chat spawning) hands over the
 * repository row it actually holds and cannot spell the unprojected variant.
 */
export type ConversationCreatedEventInput =
  | {
      scope: "session";
      projectName: string;
      sessionName: string;
      conversation: StoredConversationState;
    }
  | {
      scope: "project";
      projectName: string;
      conversation: StoredConversationState;
    };

export function buildConversationCreatedEvent(
  input: ConversationCreatedEventInput,
): ConversationCreatedEvent {
  return conversationCreatedEventSchema.parse({
    ...input,
    type: "conversation-created",
    conversation: toPublicConversationState(input.conversation),
  });
}
