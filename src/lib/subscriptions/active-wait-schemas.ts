import { z } from "zod";
import { sourceFactSchema, subscriptionRecipientSchema } from "./schemas";

export const activeWaitSourceSchema = z
  .object({
    kind: z.enum(["workflow", "validation", "git_job"]),
    id: z.string().min(1).max(256),
  })
  .strict();
export type ActiveWaitSource = z.infer<typeof activeWaitSourceSchema>;

export const terminalSourceReadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("missing") }).strict(),
  z.object({ kind: z.literal("pending"), status: z.string() }).strict(),
  z
    .object({
      kind: z.literal("terminal"),
      fact: sourceFactSchema,
      resumable: z.boolean().optional(),
    })
    .strict(),
]);
export type TerminalSourceRead = z.infer<typeof terminalSourceReadSchema>;

export const activeSubscriptionWaitSchema = z
  .object({
    id: z.string().min(1),
    subscriptionId: z.string().min(1),
    recipient: subscriptionRecipientSchema,
    source: activeWaitSourceSchema,
    reason: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0),
    expiresAt: z.iso.datetime({ offset: true }),
    state: z.enum(["waiting", "ready", "settled", "cancelled"]),
    outcome: z
      .enum(["source_terminal", "source_missing", "expired"])
      .nullable(),
    deliveryId: z.string().nullable(),
    baselineOccurrenceId: z.string().min(1).nullable().optional(),
    batchId: z.string().nullable(),
    causationBatchIds: z.array(z.string().min(1)).max(8),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    finishedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type ActiveSubscriptionWait = z.infer<
  typeof activeSubscriptionWaitSchema
>;

export const subscriptionWakeBatchSchema = z
  .object({
    id: z.string().min(1),
    recipient: subscriptionRecipientSchema,
    /** One-time waits, each with the delivery of its outcome at the same position in deliveryIds. */
    waitIds: z.array(z.string().min(1)).max(6),
    deliveryIds: z.array(z.string().min(1)).max(6),
    /** New facts of followed sources that wake their recipient. */
    followDeliveryIds: z.array(z.string().min(1)).max(6).default([]),
    state: z.enum([
      "planned",
      "queued",
      "accepted",
      "failed",
      "uncertain",
      "cancelled",
    ]),
    queueMessageId: z.string().min(1),
    message: z.string().min(1).max(8000),
    causationBatchIds: z.array(z.string().min(1)).max(8),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    finishedAt: z.string().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type SubscriptionWakeBatch = z.infer<typeof subscriptionWakeBatchSchema>;

export const registerActiveWaitSchema = z
  .object({
    recipient: subscriptionRecipientSchema,
    source: activeWaitSourceSchema,
    reason: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    causationBatchIds: z.array(z.string().min(1)).max(8).default([]),
  })
  .strict();
export type RegisterActiveWaitInput = z.input<typeof registerActiveWaitSchema>;

export class ActiveWaitConflictError extends Error {
  readonly code = "ACTIVE_WAIT_QUEUE_REVIEW_REQUIRED";
  readonly status = 409;
  constructor() {
    super(
      "This wait has a queued or unresolved wake. Review or cancel that queue message before unfollowing.",
    );
    this.name = "ActiveWaitConflictError";
  }
}
