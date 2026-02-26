"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  sessionKeys,
  conversationKeys,
  notificationKeys,
} from "@/lib/query-keys";
import {
  jobStatusEventSchema,
  notificationCreatedEventSchema,
  notificationUpdatedEventSchema,
} from "@/lib/schemas";
import {
  useAddOrUpdateJob,
  useEnqueueToast,
} from "@/stores/notification.store";

export default function NotificationListener(): null {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();
  const enqueueToast = useEnqueueToast();
  const hadErrorRef = useRef(false);

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("conversation-status", () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("ask-question", () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("session-finished", () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("job-status", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = jobStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        const data = result.data;
        addOrUpdateJob(data);

        // On completed merge/commit/resolve: invalidate session queries
        if (
          data.status === "completed" &&
          (data.jobType === "merge" ||
            data.jobType === "commit" ||
            data.jobType === "resolve-conflicts")
        ) {
          void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        }
      } catch {
        // best-effort: ignore malformed events
      }
    });

    // New: notification-created events → invalidate cache + enqueue toast
    es.addEventListener("notification-created", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = notificationCreatedEventSchema.safeParse(parsed);
        if (!result.success) return;

        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
        enqueueToast(result.data.notification);
      } catch {
        // best-effort
      }
    });

    // New: notification-updated events → invalidate cache
    es.addEventListener("notification-updated", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = notificationUpdatedEventSchema.safeParse(parsed);
        if (!result.success) return;

        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
      } catch {
        // best-effort
      }
    });

    // SSE reconnection recovery: refetch notifications on reconnect after error
    es.onerror = () => {
      hadErrorRef.current = true;
    };

    es.onopen = () => {
      if (hadErrorRef.current) {
        hadErrorRef.current = false;
        // Reconnected after error — refetch to reconcile missed events
        void queryClient.invalidateQueries({
          queryKey: notificationKeys.all,
        });
      }
    };

    return () => {
      es.close();
    };
  }, [queryClient, addOrUpdateJob, enqueueToast]);

  return null;
}
