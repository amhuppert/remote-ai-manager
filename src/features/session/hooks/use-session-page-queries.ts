"use client";

import { useCollaborationListQuery } from "@/lib/collaboration/queries";

import { useMemo } from "react";
import { useConversationsQuery } from "@/lib/conversations/queries";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import { useSessionQuery } from "@/lib/sessions/queries";

export function useSessionPageQueries(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const conversationsQuery = useConversationsQuery(projectName, sessionName);
  const collaborationListQuery = useCollaborationListQuery(
    projectName,
    sessionName,
    { includeAll: true },
  );
  const messagesQuery = useConversationMessagesQuery(
    projectName,
    sessionName,
    conversationId,
  );

  const rawMessages = useMemo(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );

  return {
    sessionQuery,
    conversationsQuery,
    collaborationListQuery,
    messagesQuery,
    rawMessages,
  };
}
