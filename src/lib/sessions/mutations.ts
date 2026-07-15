import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
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

function withSessionsArchived(
  sessions: SessionListItem[] | undefined,
  sessionNames: ReadonlySet<string>,
  archived: boolean,
): SessionListItem[] | undefined {
  return sessions?.map((s) =>
    sessionNames.has(s.sessionName) ? { ...s, archived } : s,
  );
}

function withoutSessions(
  sessions: SessionListItem[] | undefined,
  sessionNames: ReadonlySet<string>,
): SessionListItem[] | undefined {
  return sessions?.filter((s) => !sessionNames.has(s.sessionName));
}

function withoutSessionsActiveConversations(
  active: ActiveConversationsResponse | undefined,
  projectName: string,
  sessionNames: ReadonlySet<string>,
): ActiveConversationsResponse | undefined {
  if (active === undefined) return undefined;
  return {
    ...active,
    conversations: active.conversations.filter(
      (c) =>
        !(
          c.scope === "session" &&
          c.projectName === projectName &&
          sessionNames.has(c.sessionName)
        ),
    ),
  };
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

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (sessionName: string) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions?sessionName=${encodeURIComponent(sessionName)}`,
          "delete-session",
          { method: "DELETE" },
        ),
      updates: [
        cacheUpdate<string, SessionListItem[]>({
          key: () => sessionKeys.list(projectName),
          update: (old, sessionName) =>
            withoutSessions(old, new Set([sessionName])),
        }),
        cacheUpdate<string, ActiveConversationsResponse>({
          key: () => conversationKeys.active(),
          update: (old, sessionName) =>
            withoutSessionsActiveConversations(
              old,
              projectName,
              new Set([sessionName]),
            ),
        }),
      ],
      onSettled: (sessionName) => {
        invalidateTicketSessionLifecycle(queryClient, projectName, [
          sessionName,
        ]);
      },
    }),
  );
}

export function useArchiveSessionMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
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
      updates: [
        cacheUpdate<boolean, SessionListItem[]>({
          key: () => sessionKeys.list(projectName),
          update: (old, archived) =>
            withSessionsArchived(old, new Set([sessionName]), archived),
        }),
        cacheUpdate<boolean, ActiveConversationsResponse>({
          key: () => conversationKeys.active(),
          update: (old, archived) =>
            archived
              ? withoutSessionsActiveConversations(
                  old,
                  projectName,
                  new Set([sessionName]),
                )
              : undefined,
        }),
      ],
    }),
  );
}

export function useTddToggleMutation(projectName: string, sessionName: string) {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
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
      updates: [
        cacheUpdate<boolean, SessionListItem[]>({
          key: () => sessionKeys.list(projectName),
          update: (old, tddEnabled) =>
            old?.map((s) =>
              s.sessionName === sessionName ? { ...s, tddEnabled } : s,
            ),
        }),
      ],
    }),
  );
}

export function useBulkSessionsMutation(projectName: string) {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
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
      updates: [
        cacheUpdate<BulkSessionsRequest, SessionListItem[]>({
          key: () => sessionKeys.list(projectName),
          update: (old, req) => {
            const sessionNames = new Set(req.sessionNames);
            return req.op === "delete"
              ? withoutSessions(old, sessionNames)
              : withSessionsArchived(old, sessionNames, req.op === "archive");
          },
        }),
        cacheUpdate<BulkSessionsRequest, ActiveConversationsResponse>({
          key: () => conversationKeys.active(),
          update: (old, req) =>
            req.op === "delete" || req.op === "archive"
              ? withoutSessionsActiveConversations(
                  old,
                  projectName,
                  new Set(req.sessionNames),
                )
              : undefined,
        }),
      ],
      onSettled: (req) => {
        if (req.op === "delete") {
          invalidateTicketSessionLifecycle(
            queryClient,
            projectName,
            req.sessionNames,
          );
        }
      },
    }),
  );
}

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
          key: (vars) => sessionKeys.list(vars.projectName),
          update: (old, vars) =>
            withSessionsArchived(
              old,
              new Set([vars.sessionName]),
              vars.archived,
            ),
        }),
        cacheUpdate<
          GenericArchiveSessionVariables,
          ActiveConversationsResponse
        >({
          key: () => conversationKeys.active(),
          update: (old, vars) =>
            vars.archived
              ? withoutSessionsActiveConversations(
                  old,
                  vars.projectName,
                  new Set([vars.sessionName]),
                )
              : undefined,
        }),
      ],
    }),
  );
}
