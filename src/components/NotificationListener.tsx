"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/query-keys";
import type { SessionReadyEvent } from "@/types";

export default function NotificationListener(): null {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (Notification.permission === "default") {
      Notification.requestPermission();
    }

    const es = new EventSource("/api/events");

    es.addEventListener("session-ready", (e: MessageEvent) => {
      // Invalidate session queries so any open page picks up the change
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });

      if (Notification.permission !== "granted") return;

      let event: SessionReadyEvent;
      try {
        event = JSON.parse(e.data) as SessionReadyEvent;
      } catch {
        return;
      }

      const notification = new Notification(
        `${event.sessionName} is ready`,
        {
          body: `Project: ${event.projectName}`,
          tag: `session-ready-${event.conversationId}`,
        },
      );

      notification.onclick = () => {
        window.focus();
        const url = `/projects/${encodeURIComponent(event.projectName)}/${encodeURIComponent(event.sessionName)}/${encodeURIComponent(event.conversationId)}`;
        window.location.href = url;
        notification.close();
      };
    });

    return () => {
      es.close();
    };
  }, [queryClient]);

  return null;
}
