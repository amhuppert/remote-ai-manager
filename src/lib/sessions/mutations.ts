import { useMutation, useQueryClient } from "@tanstack/react-query";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { mutationFetch } from "@/lib/api/fetcher";
import { cacheUpdate, createOptimisticMutation } from "@/lib/api/optimistic";
import {
  bulkSessionsResponseSchema,
  type BulkSessionsRequest,
  type BulkSessionsResponse,
  type SessionListItem,
} from "@/lib/sessions/schemas";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import { invalidateTicketSessionLifecycle } from "@/lib/tickets/cache-lifecycle";
import {
  withSessionsArchived,
  withoutSessions,
  withoutSessionsActiveConversations,
} from "./cache-updates";

export { useCreateSessionMutation } from "./create-mutation";
export { useGenericArchiveSessionMutation } from "./generic-archive-mutation";

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
