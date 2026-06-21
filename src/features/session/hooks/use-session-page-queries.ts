"use client";

import { useMemo } from "react";
import { useConversationsQuery } from "@/lib/conversations/queries";
import { useConversationMessagesQuery } from "@/hooks/conversation/use-conversation-messages-query";
import {
  useCollaborationListQuery,
  useGraphWorkflowExecutionQuery,
} from "@/lib/workflows/queries";
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
  const graphWorkflowExecutionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
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
    graphWorkflowExecutionQuery,
    messagesQuery,
    rawMessages,
  };
}
