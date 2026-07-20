"use client";

import { useEffect, useId } from "react";

import type { QuickTicketConversationRegistration } from "@/lib/tickets/quick-ticket-context";
import { useQuickTicketStore } from "@/stores/quick-ticket.store";

type Registration = Omit<QuickTicketConversationRegistration, "token">;

export function useQuickTicketConversationRegistration(
  registration: Registration | null,
): void {
  const token = useId();
  const projectName = registration?.projectName;
  const sessionName = registration?.sessionName;
  const conversationId = registration?.conversationId;
  const title = registration?.title;

  useEffect(() => {
    if (
      projectName === undefined ||
      sessionName === undefined ||
      conversationId === undefined ||
      title === undefined
    ) {
      return;
    }
    useQuickTicketStore.getState().registerQuickTicketConversation({
      token,
      projectName,
      sessionName,
      conversationId,
      title,
    });
    return () => {
      useQuickTicketStore.getState().unregisterQuickTicketConversation(token);
    };
  }, [conversationId, projectName, sessionName, title, token]);
}
