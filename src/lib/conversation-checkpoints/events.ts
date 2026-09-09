/**
 * The scoped checkpoint SSE frame (design §9).
 *
 * One event type covers every durable phase change, and its whole body is the
 * public receipt: there is no second projection to keep in step with the one
 * `GET /checkpoints/<id>` returns, and nothing a publisher can add on the way
 * to the wire. SSE is an invalidation/update channel — after a reconnect the
 * GET is the authority, and a client that missed frames recovers by reading it.
 *
 * Both members are `.strict()`. The transport stamps `_sentAt` on send and
 * strips it on receive (`events/sse-envelope.ts`), so strictness costs a
 * consumer nothing and buys the guarantee that matters here: an extra field —
 * a seed, a provider reference, a project path — cannot ride along unnoticed,
 * because parsing a constructed frame rejects it.
 */

import { z } from "zod";

import {
  projectEventIdentity,
  sessionEventIdentity,
} from "@/lib/conversations/schemas";

import { checkpointReceiptSchema } from "./receipt";

export const CONVERSATION_CHECKPOINT_UPDATED_EVENT =
  "conversation-checkpoint-updated" as const;

export const conversationCheckpointUpdatedEventSchema = z.discriminatedUnion(
  "scope",
  [
    z
      .object({
        type: z.literal(CONVERSATION_CHECKPOINT_UPDATED_EVENT),
        ...sessionEventIdentity,
        // Non-empty: the conversation id is the cache key every consumer
        // dispatches on, and an empty one would silently patch nothing.
        conversationId: z.string().min(1),
        receipt: checkpointReceiptSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal(CONVERSATION_CHECKPOINT_UPDATED_EVENT),
        ...projectEventIdentity,
        conversationId: z.string().min(1),
        receipt: checkpointReceiptSchema,
      })
      .strict(),
  ],
);
export type ConversationCheckpointUpdatedEvent = z.infer<
  typeof conversationCheckpointUpdatedEventSchema
>;
