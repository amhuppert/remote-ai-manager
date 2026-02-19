"use client";

import { useEffect } from "react";
import type { SessionReadyEvent } from "@/types";

export default function NotificationListener(): null {
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      return;
    }

    if (Notification.permission === "default") {
      Notification.requestPermission();
    }

    const es = new EventSource("/api/events");

    es.addEventListener("session-ready", (e: MessageEvent) => {
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
  }, []);

  return null;
}
