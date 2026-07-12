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
import { invalidateTicketSessionLifecycle } from "@/lib/tickets/cache-lifecycle";

interface SessionCachesSnapshot {
  previousSessions: SessionListItem[] | undefined;
  previousActive: ActiveConversationsResponse | undefined;
}

async function cancelSessionCaches(
  client: QueryClient,
  projectName: string,
): Promise<void> {
  await client.cancelQueries({ queryKey: sessionKeys.list(projectName) });
  await client.cancelQueries({ queryKey: conversationKeys.active() });
}

function snapshotSessionCaches(
  client: QueryClient,
  projectName: string,
): SessionCachesSnapshot {
  return {
    previousSessions: client.getQueryData<SessionListItem[]>(
      sessionKeys.list(projectName),
    ),
    previousActive: client.getQueryData<ActiveConversationsResponse>(
      conversationKeys.active(),
    ),
  };
}

function rollbackSessionCaches(
  client: QueryClient,
  projectName: string,
  snapshot: SessionCachesSnapshot | undefined,
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

function invalidateSessionCaches(
  client: QueryClient,
  projectName: string,
): void {
  void client.invalidateQueries({ queryKey: sessionKeys.list(projectName) });
  void client.invalidateQueries({ queryKey: conversationKeys.active() });
}

function setSessionsArchived(
  client: QueryClient,
  projectName: string,
  sessionNames: ReadonlySet<string>,
  archived: boolean,
): void {
  client.setQueryData<SessionListItem[]>(sessionKeys.list(projectName), (old) =>
    old?.map((s) => (sessionNames.has(s.sessionName) ? { ...s, archived } : s)),
  );
}

function removeSessionsFromList(
  client: QueryClient,
  projectName: string,
  sessionNames: ReadonlySet<string>,
): void {
  client.setQueryData<SessionListItem[]>(sessionKeys.list(projectName), (old) =>
    old?.filter((s) => !sessionNames.has(s.sessionName)),
  );
}

function removeSessionsActiveConversations(
  client: QueryClient,
  projectName: string,
  sessionNames: ReadonlySet<string>,
): void {
  client.setQueryData<ActiveConversationsResponse>(
    conversationKeys.active(),
    (old) =>
      old === undefined
        ? old
        : {
            ...old,
            conversations: old.conversations.filter(
              (c) =>
                !(
                  c.scope === "session" &&
                  c.projectName === projectName &&
                  sessionNames.has(c.sessionName)
                ),
            ),
          },
  );
}

function applyArchiveSessionOptimistic(
  client: QueryClient,
  projectName: string,
  sessionName: string,
  archived: boolean,
): SessionCachesSnapshot {
  const snapshot = snapshotSessionCaches(client, projectName);
  const sessionNames = new Set([sessionName]);
  setSessionsArchived(client, projectName, sessionNames, archived);
  if (archived) {
    removeSessionsActiveConversations(client, projectName, sessionNames);
  }
  return snapshot;
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
    onMutate: async (sessionName) => {
      await cancelSessionCaches(queryClient, projectName);
      const snapshot = snapshotSessionCaches(queryClient, projectName);
      const sessionNames = new Set([sessionName]);
      removeSessionsFromList(queryClient, projectName, sessionNames);
      removeSessionsActiveConversations(queryClient, projectName, sessionNames);
      return snapshot;
    },
    onError: (_err, _vars, context) => {
      rollbackSessionCaches(queryClient, projectName, context);
    },
    onSettled: (_data, _err, sessionName) => {
      invalidateSessionCaches(queryClient, projectName);
      invalidateTicketSessionLifecycle(queryClient, projectName, [sessionName]);
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
      await cancelSessionCaches(queryClient, projectName);
      return applyArchiveSessionOptimistic(
        queryClient,
        projectName,
        sessionName,
        archived,
      );
    },
    onError: (_err, _vars, context) => {
      rollbackSessionCaches(queryClient, projectName, context);
    },
    onSettled: () => {
      invalidateSessionCaches(queryClient, projectName);
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
    onMutate: async (tddEnabled) => {
      const listKey = sessionKeys.list(projectName);
      await queryClient.cancelQueries({ queryKey: listKey });
      const previousSessions =
        queryClient.getQueryData<SessionListItem[]>(listKey);
      queryClient.setQueryData<SessionListItem[]>(listKey, (old) =>
        old?.map((s) =>
          s.sessionName === sessionName ? { ...s, tddEnabled } : s,
        ),
      );
      return { previousSessions };
    },
    onError: (_err, _vars, context) => {
      if (context?.previousSessions !== undefined) {
        queryClient.setQueryData(
          sessionKeys.list(projectName),
          context.previousSessions,
        );
      }
    },
    onSettled: () => {
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
    onMutate: async (req) => {
      await cancelSessionCaches(queryClient, projectName);
      const snapshot = snapshotSessionCaches(queryClient, projectName);
      const sessionNames = new Set(req.sessionNames);
      if (req.op === "delete") {
        removeSessionsFromList(queryClient, projectName, sessionNames);
        removeSessionsActiveConversations(
          queryClient,
          projectName,
          sessionNames,
        );
      } else {
        const archived = req.op === "archive";
        setSessionsArchived(queryClient, projectName, sessionNames, archived);
        if (archived) {
          removeSessionsActiveConversations(
            queryClient,
            projectName,
            sessionNames,
          );
        }
      }
      return snapshot;
    },
    onError: (_err, _vars, context) => {
      rollbackSessionCaches(queryClient, projectName, context);
    },
    onSettled: (_data, _err, req) => {
      invalidateSessionCaches(queryClient, projectName);
      if (req.op === "delete") {
        invalidateTicketSessionLifecycle(
          queryClient,
          projectName,
          req.sessionNames,
        );
      }
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
      await cancelSessionCaches(queryClient, projectName);
      return applyArchiveSessionOptimistic(
        queryClient,
        projectName,
        sessionName,
        archived,
      );
    },
    onError: (_err, { projectName }, context) => {
      rollbackSessionCaches(queryClient, projectName, context);
    },
    onSettled: (_data, _err, { projectName }) => {
      invalidateSessionCaches(queryClient, projectName);
    },
  });
}
