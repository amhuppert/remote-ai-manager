/**
 * Notifications domain service — the single door other domains and route
 * handlers use for notification operations.
 *
 * The service owns the write side effects the repo is forbidden to perform:
 * SSE publication (through the typed publication module,
 * `@/lib/events/publication`) and web-push dispatch. Which writes emit which
 * events is decided here in one place:
 *
 *  - a newly persisted notification (job or project-conversation) publishes
 *    `notification-created` and dispatches push — a deduped
 *    project-conversation duplicate does neither,
 *  - an unread → read transition publishes `notification-updated` (single or
 *    `id: "all"` for the bulk path) — a no-op mark publishes nothing,
 *  - reads and deletes are side-effect free.
 */

import type { SSEEvent } from "@/lib/api/sse-events";
import { publishEvent, type PublishOutcome } from "@/lib/events/publication";
import { createJobsRepo } from "@/lib/jobs/repo";
import { createLogger } from "@/lib/logging";
import { dispatchPushForNotification } from "@/lib/push-notification/dispatcher";
import { getStateDb } from "@/lib/state-store/store";
import {
  createNotificationsRepo,
  type CreateNotificationInput,
  type CreateProjectConversationNotificationInput,
  type GetNotificationsOptions,
  type MarkAsReadResult,
  type NotificationsRepo,
  type PaginatedNotifications,
} from "./repo";
import type {
  JobNotification,
  Notification,
  ProjectConversationNotification,
} from "./schemas";

const logger = createLogger("notifications.service");

export interface NotificationsServiceDeps {
  /**
   * Resolved per operation so the service tracks the shared state-db
   * singleton across test installs/resets instead of pinning one connection.
   */
  repo(): NotificationsRepo;
  publish(event: SSEEvent): PublishOutcome;
  dispatchPush(notification: Notification): void;
}

export interface NotificationsService {
  createJobNotification(input: CreateNotificationInput): JobNotification;
  createProjectConversationNotification(
    input: CreateProjectConversationNotificationInput,
  ): ProjectConversationNotification;
  getNotifications(options?: GetNotificationsOptions): PaginatedNotifications;
  markAsRead(id: string): MarkAsReadResult;
  /** Returns the number of rows transitioned unread → read. */
  markAllAsRead(): number;
  deleteNotification(id: string): boolean;
  deleteAllNotifications(): number;
  deleteNotificationsForSession(
    projectName: string,
    sessionName: string,
  ): number;
  deleteNotificationsForProject(projectName: string): number;
  getUnreadCount(): number;
  notificationExists(id: string): boolean;
  cleanupOldNotifications(retentionDays?: number): number;
}

export function createNotificationsService(
  deps: NotificationsServiceDeps,
): NotificationsService {
  function emitCreated(notification: Notification): void {
    deps.publish({ type: "notification-created", notification });
    deps.dispatchPush(notification);
  }

  return {
    createJobNotification(input) {
      const notification = deps.repo().createJobNotification(input);
      emitCreated(notification);
      return notification;
    },

    createProjectConversationNotification(input) {
      const result = deps.repo().createProjectConversationNotification(input);
      if (result.created) {
        emitCreated(result.notification);
      } else {
        logger.debug("notification.deduped", {
          notificationId: result.notification.id,
          dedupeKey: input.dedupeKey,
        });
      }
      return result.notification;
    },

    getNotifications(options) {
      return deps.repo().getNotifications(options);
    },

    markAsRead(id) {
      const result = deps.repo().markAsRead(id);
      if (result.updated) {
        deps.publish({ type: "notification-updated", id, read: true });
      }
      return result;
    },

    markAllAsRead() {
      const changed = deps.repo().markAllAsRead();
      if (changed > 0) {
        deps.publish({ type: "notification-updated", id: "all", read: true });
      }
      return changed;
    },

    deleteNotification(id) {
      return deps.repo().deleteNotification(id);
    },

    deleteAllNotifications() {
      return deps.repo().deleteAllNotifications();
    },

    deleteNotificationsForSession(projectName, sessionName) {
      return deps
        .repo()
        .deleteNotificationsForSession(projectName, sessionName);
    },

    deleteNotificationsForProject(projectName) {
      return deps.repo().deleteNotificationsForProject(projectName);
    },

    getUnreadCount() {
      return deps.repo().getUnreadCount();
    },

    notificationExists(id) {
      return deps.repo().notificationExists(id);
    },

    cleanupOldNotifications(retentionDays) {
      return deps.repo().cleanupOldNotifications(retentionDays);
    },
  };
}

let _defaultService: NotificationsService | null = null;

export function getNotificationsService(): NotificationsService {
  _defaultService ??= createNotificationsService({
    repo: () => createNotificationsRepo(getStateDb()),
    publish: publishEvent,
    dispatchPush: dispatchPushForNotification,
  });
  return _defaultService;
}

/**
 * Terminal-state notification entry point for the background-jobs pipeline;
 * persists via the default service so SSE + push side effects fire.
 */
export function createJobNotification(
  input: CreateNotificationInput,
): JobNotification {
  return getNotificationsService().createJobNotification(input);
}

export interface InitializeNotificationsDeps {
  /** Marks stale running jobs failed and records their notifications. */
  recoverStaleJobs(): number;
  cleanupOldNotifications(): number;
}

/**
 * Startup routine: ensures the schema is initialized (via the shared state-db
 * open path), sweeps stale jobs, and applies notification retention.
 */
export function initializeNotifications(
  deps?: InitializeNotificationsDeps,
): void {
  const resolved: InitializeNotificationsDeps = deps ?? {
    recoverStaleJobs: () => createJobsRepo(getStateDb()).recoverStaleJobs(),
    cleanupOldNotifications: () =>
      getNotificationsService().cleanupOldNotifications(),
  };

  const recovered = resolved.recoverStaleJobs();
  const cleaned = resolved.cleanupOldNotifications();
  logger.info("notification-db.initialized", {
    recoveredJobs: recovered,
    cleanedNotifications: cleaned,
  });
}
