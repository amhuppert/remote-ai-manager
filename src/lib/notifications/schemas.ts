import { z } from "zod";
import { jobTypeSchema } from "@/lib/jobs/schemas";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";

// ============================================================
// Push Notification Config
// ============================================================

const pushTriggerSchema = z.object({
  jobCompleted: z.boolean().default(true),
  waitingForInput: z.boolean().default(true),
  workflowCompleted: z.boolean().default(true),
  workflowHalted: z.boolean().default(true),
  conversationIdle: z.boolean().default(true),
});

export const pushNotificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["ntfy", "pushover"]).default("ntfy"),
  serverUrl: z.string().default("https://ntfy.sh"),
  topic: z.string().default(""),
  triggers: pushTriggerSchema.default({
    jobCompleted: true,
    waitingForInput: true,
    workflowCompleted: true,
    workflowHalted: true,
    conversationIdle: true,
  }),
});
export type PushNotificationConfig = z.infer<
  typeof pushNotificationConfigSchema
>;

const rawPushTriggerSchema = z.object({
  jobCompleted: z.boolean().optional(),
  waitingForInput: z.boolean().optional(),
  workflowCompleted: z.boolean().optional(),
  workflowHalted: z.boolean().optional(),
  conversationIdle: z.boolean().optional(),
});

export const rawPushNotificationConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(["ntfy", "pushover"]).optional(),
  serverUrl: z.string().optional(),
  topic: z.string().optional(),
  triggers: rawPushTriggerSchema.optional(),
});

// ============================================================
// Notification Entity
// ============================================================

const jobNotificationTypeSchema = z.enum([
  "merge-completed",
  "merge-failed",
  "merge-conflicts",
  "merge-ready-to-land",
  "merge-discarded",
  "commit-completed",
  "commit-failed",
  "resolve-completed",
  "resolve-failed",
  "rebase-completed",
  "rebase-failed",
]);
export type JobNotificationType = z.infer<typeof jobNotificationTypeSchema>;

const projectConversationNotificationTypeSchema = z.enum([
  "project-conversation-ready",
  "project-conversation-input-needed",
  "project-conversation-failed",
]);
export type ProjectConversationNotificationType = z.infer<
  typeof projectConversationNotificationTypeSchema
>;

export type NotificationType =
  | JobNotificationType
  | ProjectConversationNotificationType;

const notificationBaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  message: z.string(),
  read: z.boolean(),
  projectName: z.string(),
  createdAt: z.string(),
});

export const jobNotificationSchema = notificationBaseSchema.extend({
  source: z.literal("job"),
  type: jobNotificationTypeSchema,
  sessionName: z.string(),
  branchName: z.string(),
  jobId: z.string(),
  jobType: jobTypeSchema,
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  targetBranch: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const projectConversationNotificationSchema =
  notificationBaseSchema.extend({
    source: z.literal("project-conversation"),
    type: projectConversationNotificationTypeSchema,
    conversationId: z.string(),
    conversationName: z.string().nullable(),
    status: z.enum(["awaiting", "waiting_for_input", "failed"]),
    errorMessage: z.string().optional(),
  });

export const notificationSchema = registerTrustedSchema(
  z.discriminatedUnion("source", [
    jobNotificationSchema,
    projectConversationNotificationSchema,
  ]),
  "notificationSchema",
);
export type Notification = z.infer<typeof notificationSchema>;
export type JobNotification = z.infer<typeof jobNotificationSchema>;
export type ProjectConversationNotification = z.infer<
  typeof projectConversationNotificationSchema
>;

// ============================================================
// SSE Events
// ============================================================

export const notificationCreatedEventSchema = z.object({
  type: z.literal("notification-created"),
  notification: notificationSchema,
});
export type NotificationCreatedEvent = z.infer<
  typeof notificationCreatedEventSchema
>;

export const notificationUpdatedEventSchema = z.object({
  type: z.literal("notification-updated"),
  id: z.string(),
  read: z.boolean(),
});
export type NotificationUpdatedEvent = z.infer<
  typeof notificationUpdatedEventSchema
>;

// ============================================================
// API Request/Response Schemas
// ============================================================

export const getNotificationsQuerySchema = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const notificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  total: z.number(),
  unreadCount: z.number(),
});
export type NotificationsResponse = z.infer<typeof notificationsResponseSchema>;

export const markReadRequestSchema = z.object({
  read: z.literal(true),
});
