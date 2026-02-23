"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionKeys, conversationKeys } from "@/lib/query-keys";

export default function NotificationListener(): null {
  const queryClient = useQueryClient();

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

    return () => {
      es.close();
    };
  }, [queryClient]);

  return null;
}
