import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/fetcher";
import { notificationKeys } from "@/lib/notifications/query-keys";
import { notificationsResponseSchema } from "@/lib/notifications/schemas";

export function useNotificationsQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: notificationKeys.list(),
    queryFn: () => apiFetch("/api/notifications", notificationsResponseSchema),
    enabled: options?.enabled ?? true,
  });
}
