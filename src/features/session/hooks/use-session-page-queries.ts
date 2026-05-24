"use client";

import { useMemo } from "react";
import {
  useConversationMessagesQuery,
  useConversationsQuery,
} from "@/lib/conversations/queries";
import { useCollaborationListQuery } from "@/lib/workflows/queries";
import { useSessionQuery } from "@/lib/sessions/queries";
import { useSessionDiffQuery, useCommitsQuery } from "@/lib/git/queries";

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
  const diffQuery = useSessionDiffQuery(projectName, sessionName);
  const commitsQuery = useCommitsQuery(projectName, sessionName);

  const rawMessages = useMemo(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );
  const diff = diffQuery.data ?? {
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
  const commits = commitsQuery.data ?? [];

  return {
    sessionQuery,
    conversationsQuery,
    collaborationListQuery,
    messagesQuery,
    diffQuery,
    commitsQuery,
    rawMessages,
    diff,
    commits,
  };
}
