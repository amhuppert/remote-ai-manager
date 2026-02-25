"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionKeys, conversationKeys } from "@/lib/query-keys";
import { jobStatusEventSchema } from "@/lib/schemas";
import { useAddOrUpdateJob } from "@/stores/notification.store";

export default function NotificationListener(): null {
  const queryClient = useQueryClient();
  const addOrUpdateJob = useAddOrUpdateJob();

  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("conversation-status", () => {
      // Invalidate active conversations query for unified panel refresh
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      // Also invalidate session queries for status display updates
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("ask-question", () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active,
      });
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    });

    es.addEventListener("job-status", (event) => {
      try {
        const parsed = JSON.parse(event.data);
        const result = jobStatusEventSchema.safeParse(parsed);
        if (!result.success) return;
        const data = result.data;
        addOrUpdateJob(data);

        // On completed merge: invalidate session queries
        if (data.jobType === "merge" && data.status === "completed") {
          void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        }
        // On completed commit: invalidate session queries
        if (data.jobType === "commit" && data.status === "completed") {
          void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
        }
      } catch {
        // best-effort: ignore malformed events
      }
    });

    return () => {
      es.close();
    };
  }, [queryClient, addOrUpdateJob]);

  return null;
}
