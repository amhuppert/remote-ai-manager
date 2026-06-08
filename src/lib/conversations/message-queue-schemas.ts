import { z } from "zod";

import { messageContentBlockSchema } from "@/lib/conversations/message-content-schemas";

// Lifecycle of a durably-queued follow-up message. `pending` and `delivering`
// are active; `delivered`, `failed`, and `cancelled` are terminal. Ordered to
// match the lifecycle progression described in design "Data Models".
export const PENDING_QUEUED_MESSAGE_STATUSES = [
  "pending",
  "delivering",
  "delivered",
  "failed",
  "cancelled",
] as const;

export const pendingQueuedMessageStatusSchema = z.enum(
  PENDING_QUEUED_MESSAGE_STATUSES,
);
export type PendingQueuedMessageStatus = z.infer<
  typeof pendingQueuedMessageStatusSchema
>;

// A durably-persisted queued message stored in `ConversationState.pendingQueue`.
// The queue — not the JSONL transcript — is the source of truth for this entry
// until delivery to the agent is confirmed. `deliveryAttemptId` guards against
// a stale failure handler mutating a newer delivery attempt.
export const pendingQueuedMessageSchema = z.object({
  id: z.string(),
  content: z.array(messageContentBlockSchema),
  status: pendingQueuedMessageStatusSchema,
  enqueuedAt: z.string(),
  updatedAt: z.string(),
  deliveryStartedAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  deliveryAttemptId: z.string().nullable(),
  attemptCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type PendingQueuedMessage = z.infer<typeof pendingQueuedMessageSchema>;

// Client-safe projection of a pending queued message used in `message-queued`
// and `message-queue-updated` events and the pending display. Omits the
// internal delivery-claim fields (`deliveryStartedAt`, `deliveryAttemptId`,
// `attemptCount`) that the client never needs to render a pending entry.
export const queuedMessageViewSchema = z.object({
  id: z.string(),
  content: z.array(messageContentBlockSchema),
  status: pendingQueuedMessageStatusSchema,
  enqueuedAt: z.string(),
  updatedAt: z.string(),
  deliveredAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type QueuedMessageView = z.infer<typeof queuedMessageViewSchema>;

// Typed error codes returned by the queue route handlers and consumed by the
// client to surface specific failure reasons (design "queue route handlers").
export const QUEUE_ERROR_CODES = [
  "EMPTY_MESSAGE",
  "NOT_RUNNING",
  "NON_INTERACTIVE_CONVERSATION",
  "UNSUPPORTED_BACKEND",
  "NOT_CANCELLABLE",
] as const;

export const queueErrorCodeSchema = z.enum(QUEUE_ERROR_CODES);
export type QueueErrorCode = z.infer<typeof queueErrorCodeSchema>;
