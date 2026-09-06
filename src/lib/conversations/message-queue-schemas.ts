import { z } from "zod";

import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import { messageContentBlockSchema } from "@/lib/conversations/message-content-schemas";

// Uncertain deliveries retain their content and block automatic delivery until
// the user explicitly reviews whether repeating the request is appropriate.
export const PENDING_QUEUED_MESSAGE_STATUSES = [
  "pending",
  "delivering",
  "uncertain",
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

/** A row still owned by the queue, including a delivery awaiting review. */
export function isActiveQueuedMessageStatus(
  status: PendingQueuedMessageStatus,
): status is Exclude<PendingQueuedMessageStatus, "delivered" | "cancelled"> {
  return (
    status === "pending" ||
    status === "delivering" ||
    queuedMessageNeedsReview(status)
  );
}

export function queuedMessageNeedsReview(
  status: PendingQueuedMessageStatus,
): boolean {
  return status === "uncertain" || status === "failed";
}

export const queueReviewActionSchema = z.enum(["retry", "discard"]);
export type QueueReviewAction = z.infer<typeof queueReviewActionSchema>;

/**
 * A row that will never change again. The client reads this as "stop showing it
 * as pending": a delivered row is now a transcript message, and a cancelled
 * row was explicitly discarded.
 */
export function isTerminalQueuedMessageStatus(
  status: PendingQueuedMessageStatus,
): boolean {
  return !isActiveQueuedMessageStatus(status);
}

// Provenance tag on a queue row whose content is machine-built rather than
// typed by the user. `question_answers` marks the delimited
// <cc-question-answers> block the answer route enqueues, so the UI renders an
// answer card instead of the raw text.
export const queuedMessageMetadataSchema = z.object({
  kind: z.literal("question_answers"),
  questionBatchId: z.string(),
});
export type QueuedMessageMetadata = z.infer<typeof queuedMessageMetadataSchema>;

// A durably-persisted queued message stored in `ConversationState.pendingQueue`.
// The queue — not the JSONL transcript — is the source of truth for this entry
// until delivery to the agent is confirmed. `deliveryAttemptId` guards against
// a stale failure handler mutating a newer delivery attempt.
export const pendingQueuedMessageSchema = z
  .object({
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
    metadata: queuedMessageMetadataSchema.nullable().default(null),
    modelSelection: backendModelSelectionSchema.optional(),
  })
  .strict();
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
  metadata: queuedMessageMetadataSchema.nullable().default(null),
  modelSelection: backendModelSelectionSchema.optional(),
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
  "NOT_REVIEWABLE",
  "INVALID_QUEUE_REVIEW",
  "QUEUE_REVIEW_REQUIRED",
] as const;

export const queueErrorCodeSchema = z.enum(QUEUE_ERROR_CODES);
export type QueueErrorCode = z.infer<typeof queueErrorCodeSchema>;
