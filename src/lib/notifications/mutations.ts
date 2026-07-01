import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mutationFetch } from "@/lib/api/fetcher";
import { notificationKeys } from "@/lib/notifications/query-keys";
import type { NotificationsResponse } from "@/lib/notifications/schemas";

export function useMarkNotificationAsReadMutation() {
  const queryClient = useQueryClient();
  const listKey = notificationKeys.list();

  return useMutation({
    mutationFn: (notificationId: string) =>
      mutationFetch(
        `/api/notifications/${encodeURIComponent(notificationId)}`,
        "mark-notification-read",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: true }),
        },
      ),
    onMutate: async (notificationId) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<NotificationsResponse>(listKey);
      queryClient.setQueryData<NotificationsResponse>(listKey, (old) => {
        if (!old) return old;
        const target = old.notifications.find((n) => n.id === notificationId);
        const wasUnread = target ? !target.read : false;
        return {
          ...old,
          notifications: old.notifications.map((n) =>
            n.id === notificationId ? { ...n, read: true } : n,
          ),
          unreadCount: wasUnread
            ? Math.max(0, old.unreadCount - 1)
            : old.unreadCount,
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

export function useMarkAllNotificationsAsReadMutation() {
  const queryClient = useQueryClient();
  const listKey = notificationKeys.list();

  return useMutation({
    mutationFn: () =>
      mutationFetch(
        "/api/notifications/mark-all-read",
        "mark-all-notifications-read",
        { method: "POST" },
      ),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous = queryClient.getQueryData<NotificationsResponse>(listKey);
      queryClient.setQueryData<NotificationsResponse>(listKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          notifications: old.notifications.map((n) =>
            n.read ? n : { ...n, read: true },
          ),
          unreadCount: 0,
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
