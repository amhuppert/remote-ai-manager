import { z } from "zod";
import { conversationTargetSchema } from "@/lib/conversations/conversation-target";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
  subscriptionSourceRefSchema,
  publicSubscriptionSourceRefSchema,
  subscriptionRecipientSchema,
} from "./schemas";
import {
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
} from "./active-wait-schemas";

export const subscriptionsChangedEventSchema = subscriptionRecipientSchema
  .extend({
    type: z.literal("subscriptions-changed"),
    source: subscriptionSourceRefSchema.optional(),
  })
  .strict();
export type SubscriptionsChangedEvent = z.infer<
  typeof subscriptionsChangedEventSchema
>;

export const subscriptionCatalogSchema = z
  .object({
    sources: z.array(
      z
        .object({
          kind: publicSubscriptionSourceRefSchema.shape.kind,
          label: z.string(),
          description: z.string(),
          identityDescription: z.string(),
          allowedModes: z.array(z.enum(["passive", "active"])),
          eventKinds: z.array(
            z.object({ id: z.string(), label: z.string() }).strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type SubscriptionCatalog = z.infer<typeof subscriptionCatalogSchema>;

export const subscribeRequestSchema = z
  .object({
    source: publicSubscriptionSourceRefSchema.extend({
      id: z.string().trim().min(1).max(256),
    }),
    reason: z
      .string()
      .min(1)
      .max(1000)
      .refine((value) => value.trim().length > 0, "A purpose is required"),
    mode: z.enum(["passive", "active"]).default("passive"),
    eventKinds: z
      .array(z.string().min(1))
      .min(1)
      .max(100)
      .nullable()
      .default(null),
    expiresIn: z.number().int().min(1).max(604800).optional(),
  })
  .strict();
export type SubscribeRequest = z.input<typeof subscribeRequestSchema>;

export const subscriptionControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }).strict(),
  z.object({ action: z.literal("resume") }).strict(),
  z.object({ action: z.literal("cancel") }).strict(),
  z
    .object({
      action: z.literal("mode"),
      mode: z.enum(["passive", "active"]),
      expiresIn: z.number().int().min(1).max(604800).optional(),
    })
    .strict(),
]);
export type SubscriptionControlRequest = z.infer<
  typeof subscriptionControlRequestSchema
>;

export const subscriptionDetailSchema = z
  .object({
    subscription: conversationSubscriptionSchema,
    wait: activeSubscriptionWaitSchema.nullable(),
    batch: subscriptionWakeBatchSchema.nullable(),
  })
  .strict();
export type SubscriptionDetail = z.infer<typeof subscriptionDetailSchema>;
export const inboxPreferencesSchema = z
  .object({ hintsEnabled: z.boolean() })
  .strict();
export const inboxSummarySchema = z
  .object({
    pendingCount: z.number().int().nonnegative(),
    hintsEnabled: z.boolean(),
  })
  .strict();

export const subscriptionOwnerSchema = z
  .object({
    target: conversationTargetSchema,
    projectPath: z.string(),
    conversationTitle: z.string(),
    archived: z.boolean(),
  })
  .strict();
export type SubscriptionOwner = z.infer<typeof subscriptionOwnerSchema>;

export const subscriptionViewSchema = z
  .object({
    subscription: conversationSubscriptionSchema,
    owner: subscriptionOwnerSchema,
    sourceTitle: z.string(),
    sourceHref: z.string().nullable(),
    wait: activeSubscriptionWaitSchema
      .omit({
        reason: true,
        causationBatchIds: true,
        recipient: true,
        source: true,
      })
      .nullable(),
    batch: subscriptionWakeBatchSchema
      .pick({
        id: true,
        state: true,
        createdAt: true,
        finishedAt: true,
        lastError: true,
      })
      .nullable(),
    pendingCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    holdReason: z.string().nullable(),
    rateLimitUntil: z.string().nullable(),
    actions: z.array(
      z.enum(["pause", "resume", "passive", "active", "cancel", "unfollow"]),
    ),
  })
  .strict();
export type SubscriptionView = z.infer<typeof subscriptionViewSchema>;

export const subscriptionScopeSchema = z
  .object({
    project: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    conversation: z.string().min(1).optional(),
    sourceKind: subscriptionSourceRefSchema.shape.kind.optional(),
    sourceId: z.string().min(1).optional(),
    subscriptionId: z.string().min(1).optional(),
  })
  .strict();
export type SubscriptionScope = z.infer<typeof subscriptionScopeSchema>;
export const subscriptionOverviewQuerySchema = subscriptionScopeSchema
  .extend({
    status: z
      .enum(["all", "following", "paused", "unfollowed", "attention"])
      .default("following"),
    mode: z.enum(["all", "passive", "active"]).default("all"),
    q: z.string().max(200).default(""),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();
export type SubscriptionOverviewQuery = z.input<
  typeof subscriptionOverviewQuerySchema
>;
export const subscriptionOverviewSchema = z
  .object({
    items: z.array(subscriptionViewSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    counts: z
      .object({
        following: z.number(),
        active: z.number(),
        paused: z.number(),
        pending: z.number(),
        attention: z.number(),
      })
      .strict(),
  })
  .strict();
export type SubscriptionOverview = z.infer<typeof subscriptionOverviewSchema>;

export const inboxOverviewQuerySchema = subscriptionScopeSchema
  .extend({
    batchId: z.string().min(1).optional(),
    state: z.enum(["all", "pending", "accepted", "issues"]).default("pending"),
    read: z.enum(["all", "unread", "read"]).default("all"),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();
export type InboxOverviewQuery = z.input<typeof inboxOverviewQuerySchema>;
export const inboxViewSchema = z
  .object({
    delivery: subscriptionDeliverySchema,
    owner: subscriptionOwnerSchema,
    sourceHref: z.string().nullable(),
    readAt: z.string().nullable(),
    wakeBatchId: z.string().nullable(),
  })
  .strict();
export type InboxView = z.infer<typeof inboxViewSchema>;
export const inboxOverviewSchema = z
  .object({
    items: z.array(inboxViewSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    counts: z
      .object({
        pending: z.number(),
        accepted: z.number(),
        issues: z.number(),
        unread: z.number(),
      })
      .strict(),
  })
  .strict();
export type InboxOverview = z.infer<typeof inboxOverviewSchema>;
export const subscriptionRecipientsSchema = z
  .object({
    items: z.array(subscriptionOwnerSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  })
  .strict();
