/**
 * Notification-domain SSE reactions, registered against the shared
 * `/api/events` EventSource by the client assembly point
 * (`NotificationListener`).
 */

import type { QueryClient } from "@tanstack/react-query";
import { addSseListener } from "@/lib/api/sse";
import { notificationKeys } from "@/lib/notifications/query-keys";
import {
  notificationCreatedEventSchema,
  notificationUpdatedEventSchema,
  type Notification,
  type NotificationsResponse,
} from "@/lib/notifications/schemas";

export interface NotificationSseReactionDeps {
  queryClient: QueryClient;
  enqueueToast(notification: Notification): void;
}

export function registerNotificationSseReactions(
  es: EventSource,
  deps: NotificationSseReactionDeps,
): void {
  const { queryClient } = deps;

  // notification-created events → patch the list cache + enqueue toast. The
  // payload carries the full notification, so the fetched list is patched in
  // place (idempotent by id); an unfetched list falls back to invalidation —
  // seeding it via setQueryData would create a partial cache masquerading as
  // a fetched response.
  addSseListener(
    es,
    "notification-created",
    notificationCreatedEventSchema,
    (data) => {
      const notification = data.notification;
      const listKey = notificationKeys.list();

      const cached = queryClient.getQueryData<NotificationsResponse>(listKey);
      if (cached === undefined) {
        void queryClient.invalidateQueries({ queryKey: listKey });
      } else if (!cached.notifications.some((n) => n.id === notification.id)) {
        queryClient.setQueryData<NotificationsResponse>(listKey, {
          notifications: [notification, ...cached.notifications],
          total: cached.total + 1,
          unreadCount: cached.unreadCount + (notification.read ? 0 : 1),
        });
      }
      deps.enqueueToast(notification);
    },
  );

  // notification-updated events → invalidate cache
  addSseListener(
    es,
    "notification-updated",
    notificationUpdatedEventSchema,
    () => {
      void queryClient.invalidateQueries({
        queryKey: notificationKeys.all,
      });
    },
  );
}
