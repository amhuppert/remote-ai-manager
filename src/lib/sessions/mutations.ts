import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  sessionStateSchema,
  bulkSessionsResponseSchema,
  type BulkSessionsRequest,
  type BulkSessionsResponse,
  type CreateSessionRequest,
  type SessionListItem,
} from "@/lib/sessions/schemas";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";

interface ArchiveSessionOptimisticSnapshot {
  previousSessions: SessionListItem[] | undefined;
  previousActive: ActiveConversationsResponse | undefined;
}

function applyArchiveSessionOptimistic(
  client: QueryClient,
  projectName: string,
  sessionName: string,
  archived: boolean,
): ArchiveSessionOptimisticSnapshot {
  const sessionListKey = sessionKeys.list(projectName);
  const activeKey = conversationKeys.active();
  const previousSessions =
    client.getQueryData<SessionListItem[]>(sessionListKey);
  const previousActive =
    client.getQueryData<ActiveConversationsResponse>(activeKey);

  client.setQueryData<SessionListItem[]>(sessionListKey, (old) =>
    old?.map((s) => (s.sessionName === sessionName ? { ...s, archived } : s)),
  );

  if (archived) {
    client.setQueryData<ActiveConversationsResponse>(activeKey, (old) =>
      old === undefined
        ? old
        : {
            ...old,
            conversations: old.conversations.filter(
              (c) =>
                !(
                  c.scope === "session" &&
                  c.projectName === projectName &&
                  c.sessionName === sessionName
                ),
            ),
          },
    );
  }

  return { previousSessions, previousActive };
}

function rollbackArchiveSessionOptimistic(
  client: QueryClient,
  projectName: string,
  snapshot: ArchiveSessionOptimisticSnapshot | undefined,
): void {
  if (snapshot === undefined) return;
  if (snapshot.previousSessions !== undefined) {
    client.setQueryData(
      sessionKeys.list(projectName),
      snapshot.previousSessions,
    );
  }
  if (snapshot.previousActive !== undefined) {
    client.setQueryData(conversationKeys.active(), snapshot.previousActive);
  }
}
export function useCreateSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: CreateSessionRequest) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions`,
        "create-session",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
        },
        sessionStateSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
      // Refresh the active-conversations feed so the new session's initial
      // conversation surfaces immediately. The feed has a persistent observer
      // (the Topbar), so without this it stays cached and the new conversation
      // never appears in the /conversations tabs/panes until something else
      // refetches it.
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}

export function useDeleteSessionMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionName: string) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions?sessionName=${encodeURIComponent(sessionName)}`,
        "delete-session",
        { method: "DELETE" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

export function useArchiveSessionMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (archived: boolean) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/archive`,
        "archive-session",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        },
      ),
    onMutate: async (archived) => {
      await queryClient.cancelQueries({
        queryKey: sessionKeys.list(projectName),
      });
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      return applyArchiveSessionOptimistic(
        queryClient,
        projectName,
        sessionName,
        archived,
      );
    },
    onError: (_err, _vars, context) => {
      rollbackArchiveSessionOptimistic(queryClient, projectName, context);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}

export function useTddToggleMutation(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tddEnabled: boolean) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/tdd`,
        "tdd-toggle",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tddEnabled }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

export function useBulkSessionsMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: BulkSessionsRequest): Promise<BulkSessionsResponse> =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/bulk`,
        "bulk-sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        },
        bulkSessionsResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
    },
  });
}

/**
 * Archive a session from any project. Accepts project/session as mutation
 * variables — used from the active conversations sidebar where rows can
 * belong to sessions other than the one this component is bound to.
 */
export function useGenericArchiveSessionMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectName,
      sessionName,
      archived,
    }: {
      projectName: string;
      sessionName: string;
      archived: boolean;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/archive`,
        "archive-session",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived }),
        },
      ),
    onMutate: async ({ projectName, sessionName, archived }) => {
      await queryClient.cancelQueries({
        queryKey: sessionKeys.list(projectName),
      });
      await queryClient.cancelQueries({ queryKey: conversationKeys.active() });
      return applyArchiveSessionOptimistic(
        queryClient,
        projectName,
        sessionName,
        archived,
      );
    },
    onError: (_err, { projectName }, context) => {
      rollbackArchiveSessionOptimistic(queryClient, projectName, context);
    },
    onSettled: (_data, _err, { projectName }) => {
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.list(projectName),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}
