import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import { mutationFetch } from "@/lib/api/fetcher";
import { conversationKeys } from "@/lib/conversations/query-keys";
import {
  withSessionsArchived,
  withoutSessionsActiveConversations,
} from "@/lib/sessions/cache-updates";
import type { SessionListItem } from "@/lib/sessions/list-schemas";
import { sessionKeys } from "@/lib/sessions/query-keys";

/**
 * Archive a session from any project. Accepts project/session as mutation
 * variables — used from the active conversations sidebar where rows can
 * belong to sessions other than the one this component is bound to.
 */
interface GenericArchiveSessionVariables {
  projectName: string;
  sessionName: string;
  archived: boolean;
}

export function useGenericArchiveSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        projectName,
        sessionName,
        archived,
      }: GenericArchiveSessionVariables) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/archive`,
          "archive-session",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived }),
          },
        ),
      updates: [
        cacheUpdate<GenericArchiveSessionVariables, SessionListItem[]>({
          key: (variables) => sessionKeys.list(variables.projectName),
          update: (old, variables) =>
            withSessionsArchived(
              old,
              new Set([variables.sessionName]),
              variables.archived,
            ),
        }),
        cacheUpdate<
          GenericArchiveSessionVariables,
          ActiveConversationsResponse
        >({
          key: () => conversationKeys.active(),
          update: (old, variables) =>
            variables.archived
              ? withoutSessionsActiveConversations(
                  old,
                  variables.projectName,
                  new Set([variables.sessionName]),
                )
              : undefined,
        }),
      ],
    }),
  );
}
