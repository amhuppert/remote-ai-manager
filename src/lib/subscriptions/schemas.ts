import { z } from "zod";
import { notepadAcceptedContextSchema } from "@/lib/notepads/schemas";

export const subscriptionRecipientSchema = z
  .object({
    projectPath: z.string().min(1),
    conversationId: z.string().min(1),
  })
  .strict();
export type SubscriptionRecipient = z.infer<typeof subscriptionRecipientSchema>;

export const subscriptionSourceRefSchema = z
  .object({
    kind: z.enum([
      "notepad",
      "ticket",
      "spec",
      "validation",
      "git_job",
      "conversation",
      "run",
    ]),
    id: z.string().min(1),
  })
  .strict();
export type SubscriptionSourceRef = z.infer<typeof subscriptionSourceRefSchema>;
export const publicSubscriptionSourceRefSchema =
  subscriptionSourceRefSchema.extend({
    kind: subscriptionSourceRefSchema.shape.kind.exclude(["conversation"]),
  });
export type PublicSubscriptionSourceRef = z.infer<
  typeof publicSubscriptionSourceRefSchema
>;
export const sourceCursorSchema = z.string().nullable();
export type SourceCursor = z.infer<typeof sourceCursorSchema>;

export const sourceFactSchema = z
  .object({
    occurrenceId: z.string().min(1),
    eventKind: z.string().min(1),
    category: z.enum(["revision", "decision", "outcome", "activity"]),
    sourceTitle: z.string(),
    summary: z.string(),
    sourceText: z.string().optional(),
    notepadContext: notepadAcceptedContextSchema
      .omit({ notepadId: true })
      .optional(),
    occurredAt: z.string().min(1),
    revision: z.string().nullable(),
    outcome: z.string().nullable(),
    retrievalHandle: z.string().min(1),
    actorConversationId: z.string().nullable(),
  })
  .strict();
export type SourceFact = z.infer<typeof sourceFactSchema>;

export const sourceReadResultSchema = z
  .object({
    cursor: sourceCursorSchema,
    facts: z.array(sourceFactSchema),
    missing: z.boolean(),
    withdrawnOccurrenceIds: z.array(z.string().min(1)).optional(),
    coveredNotepadRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SourceReadResult = z.infer<typeof sourceReadResultSchema>;

export const conversationSubscriptionSchema = z
  .object({
    id: z.string().min(1),
    recipient: subscriptionRecipientSchema,
    source: subscriptionSourceRefSchema,
    reason: z.string().min(1),
    mode: z.enum(["passive", "active"]),
    /** New facts wake the recipient through a wake message instead of waiting for its next turn's briefing. */
    wakes: z.boolean().default(false),
    eventKinds: z.array(z.string().min(1)).nullable(),
    expiresAt: z.string().nullable(),
    status: z.enum(["following", "unfollowed"]),
    cursor: sourceCursorSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    unfollowedAt: z.string().nullable(),
    pausedAt: z.string().nullable(),
    missingAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type ConversationSubscription = z.infer<
  typeof conversationSubscriptionSchema
>;

export const subscriptionDeliverySchema = z
  .object({
    id: z.string().min(1),
    subscriptionId: z.string().min(1),
    recipient: subscriptionRecipientSchema,
    source: subscriptionSourceRefSchema,
    fact: sourceFactSchema,
    recordedAt: z.string().min(1),
    state: z.enum([
      "pending",
      "queued",
      "accepted",
      "failed",
      "uncertain",
      "superseded",
    ]),
    attemptId: z.string().nullable(),
    attemptCount: z.number().int().nonnegative(),
    queuedAt: z.string().nullable(),
    acceptedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type SubscriptionDelivery = z.infer<typeof subscriptionDeliverySchema>;

export const inboxQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().nonnegative().default(0),
    includeSettled: z.boolean().default(false),
  })
  .strict();
export type InboxQuery = z.input<typeof inboxQuerySchema>;
export const subscriptionInboxPageSchema = z
  .object({
    items: z.array(subscriptionDeliverySchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strict();
export type SubscriptionInboxPage = z.infer<typeof subscriptionInboxPageSchema>;

export const recipientSubscriptionPreferencesSchema = z
  .object({ hintsEnabled: z.boolean() })
  .strict();
export type RecipientSubscriptionPreferences = z.infer<
  typeof recipientSubscriptionPreferencesSchema
>;
export const subscriptionDeliveryReadStateSchema = z
  .object({
    recipient: subscriptionRecipientSchema,
    deliveryId: z.string().min(1),
    readAt: z.string().min(1),
  })
  .strict();
