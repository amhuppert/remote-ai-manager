import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { notificationKeys } from "@/lib/notifications/query-keys";
import type { NotificationsResponse } from "@/lib/notifications/schemas";

export function useDismissNotificationMutation() {
  const queryClient = useQueryClient();
  const listKey = notificationKeys.list();

  return useMutation({
    mutationFn: (notificationId: string) =>
      mutationFetch(
        `/api/notifications/${encodeURIComponent(notificationId)}`,
        "dismiss-notification",
        { method: "DELETE" },
      ),
    onMutate: async (notificationId) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<NotificationsResponse>(listKey);
      queryClient.setQueryData<NotificationsResponse>(listKey, (old) => {
        if (!old) return old;
        const target = old.notifications.find((n) => n.id === notificationId);
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
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: notificationKeys.all,
      });
    },
  });
}
