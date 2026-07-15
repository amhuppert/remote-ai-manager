import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import { notificationKeys } from "@/lib/notifications/query-keys";
import type { NotificationsResponse } from "@/lib/notifications/schemas";

export function useDismissNotificationMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (notificationId: string) =>
        mutationFetch(
          `/api/notifications/${encodeURIComponent(notificationId)}`,
          "dismiss-notification",
          { method: "DELETE" },
        ),
      updates: [
        cacheUpdate<string, NotificationsResponse>({
          key: () => notificationKeys.list(),
          update: (old, notificationId) => {
            if (!old) return old;
            const target = old.notifications.find(
              (n) => n.id === notificationId,
            );
            if (!target) return old;
            return {
              ...old,
              notifications: old.notifications.filter(
                (n) => n.id !== notificationId,
              ),
              total: Math.max(0, old.total - 1),
              unreadCount: target.read
                ? old.unreadCount
                : Math.max(0, old.unreadCount - 1),
            };
          },
        }),
      ],
      invalidateKeys: () => [notificationKeys.all],
    }),
  );
}
