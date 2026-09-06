import {
  conversationTargetApiBase,
  type ConversationTarget,
} from "./conversation-target";
import { queueReviewResponseSchema } from "@/lib/prompt/schemas";
import type { QueueReviewAction } from "./message-queue-schemas";
import {
  useMutation,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { conversationKeys } from "./query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import {
  publicConversationStateSchema,
  forkResponseSchema,
  generateConversationNameResponseSchema,
  type ConversationState,
  type AskQuestionAnswer,
} from "./schemas";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
import type { ActiveConversationsResponse } from "@/lib/active-conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { mutationFetch } from "@/lib/api/fetcher";
import {
  cacheUpdate,
  cachePrefixUpdate,
  createOptimisticMutation,
  type OptimisticCacheUpdate,
} from "@/lib/api/optimistic";
import { pushToast } from "@/stores/toast.store";

export function renamedInActive(
  active: ActiveConversationsResponse | undefined,
  conversationId: string,
  name: string | null,
): ActiveConversationsResponse | undefined {
  if (active === undefined) return undefined;
  return {
    ...active,
    conversations: active.conversations.map((c) =>
      c.id === conversationId ? { ...c, name } : c,
    ),
  };
}

function withActiveConversationArchived(
  active: ActiveConversationsResponse | undefined,
  conversationId: string,
  archived: boolean,
): ActiveConversationsResponse | undefined {
  if (active === undefined) return undefined;
  return {
    ...active,
    conversations: active.conversations.flatMap((c) => {
      if (c.id !== conversationId) return [c];
      if (c.scope === "session" && c.archived !== undefined)
        return [{ ...c, archived }];
      return archived ? [] : [c];
    }),
  };
}

type GenericSessionMutationScope = {
  scope?: "session";
  projectName: string;
  sessionName: string;
  conversationId: string;
};

type GenericProjectMutationScope = {
  scope: "project";
  projectName: string;
  conversationId: string;
};

type GenericSessionRenameConversationVariables = GenericSessionMutationScope & {
  name: string;
};

type GenericProjectRenameConversationVariables = GenericProjectMutationScope & {
  name: string;
};

type GenericRenameConversationVariables =
  | GenericSessionRenameConversationVariables
  | GenericProjectRenameConversationVariables;

type WithoutName<T> = T extends { name: string } ? Omit<T, "name"> : never;

type GenericGenerateConversationNameVariables =
  WithoutName<GenericRenameConversationVariables> & {
    messageIndex?: number;
  };

type GenericSessionArchiveConversationVariables =
  GenericSessionMutationScope & {
    archived: boolean;
  };

type GenericProjectArchiveConversationVariables =
  GenericProjectMutationScope & {
    archived: boolean;
  };

type GenericArchiveConversationVariables =
  | GenericSessionArchiveConversationVariables
  | GenericProjectArchiveConversationVariables;

type GenericConversationMutationVariables =
  | GenericRenameConversationVariables
  | GenericGenerateConversationNameVariables
  | GenericArchiveConversationVariables;

function isProjectMutationScope(
  variables: GenericConversationMutationVariables,
): variables is
  | GenericProjectRenameConversationVariables
  | Extract<GenericGenerateConversationNameVariables, { scope: "project" }>
  | GenericProjectArchiveConversationVariables {
  return variables.scope === "project";
}

function genericConversationMutationPath(
  variables: GenericConversationMutationVariables,
  action: "archive" | "generate-name" | "rename",
): string {
  const projectName = encodeURIComponent(variables.projectName);
  const conversationId = encodeURIComponent(variables.conversationId);
  if (isProjectMutationScope(variables)) {
    return `/api/projects/${projectName}/conversations/${conversationId}/${action}`;
  }

  return `/api/projects/${projectName}/sessions/${encodeURIComponent(variables.sessionName)}/conversations/${conversationId}/${action}`;
}

/**
 * The generic (project-or-session scoped) mutations patch the session
 * conversation list only for session scope; the project list carries no
 * optimistic write and is reconciled by invalidation alone.
 */
function genericConversationUpdates<
  TVars extends GenericConversationMutationVariables,
>(
  vars: TVars,
  sessionListUpdate: (
    old: ConversationState[] | undefined,
    vars: TVars,
  ) => ConversationState[] | undefined,
  activeUpdate: (
    old: ActiveConversationsResponse | undefined,
    vars: TVars,
  ) => ActiveConversationsResponse | undefined,
  projectListUpdate?: (
    old: ConversationState[] | undefined,
    vars: TVars,
  ) => ConversationState[] | undefined,
): ReadonlyArray<OptimisticCacheUpdate<TVars>> {
  const active = cachePrefixUpdate<TVars, ActiveConversationsResponse>({
    prefix: () => conversationKeys.active(),
    update: activeUpdate,
  });
  const wide: GenericConversationMutationVariables = vars;
  if (isProjectMutationScope(wide)) {
    if (projectListUpdate !== undefined) {
      return [
        cacheUpdate<TVars, ConversationState[]>({
          key: () => projectConversationKeys.list(wide.projectName),
          update: projectListUpdate,
        }),
        active,
      ];
    }
    return [active];
  }
  const listKey = conversationKeys.list(wide.projectName, wide.sessionName);
  return [
    cacheUpdate<TVars, ConversationState[]>({
      key: () => listKey,
      update: sessionListUpdate,
    }),
    active,
  ];
}

function genericConversationInvalidateKeys(
  variables: GenericConversationMutationVariables,
) {
  if (isProjectMutationScope(variables)) {
    return [
      conversationKeys.active(),
      projectConversationKeys.list(variables.projectName),
    ];
  }
  return [
    conversationKeys.active(),
    conversationKeys.list(variables.projectName, variables.sessionName),
  ];
}

/**
 * Create a session conversation. The profile is optional on the wire — the
 * route resolves the Standard Agent when nothing is named (R7) — so a caller
 * with no picker in play keeps posting an empty body.
 */
export function useCreateConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables?: { profile?: AgentProfileRef }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations`,
        "create-conversation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            variables?.profile === undefined
              ? {}
              : { profile: variables.profile },
          ),
        },
        publicConversationStateSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.list(projectName, sessionName),
      });
    },
  });
}

export function useArchiveConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const listKey = conversationKeys.list(projectName, sessionName);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        conversationId,
        archived,
      }: {
        conversationId: string;
        archived: boolean;
      }) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/archive`,
          "archive-conversation",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived }),
          },
        ),
      updates: [
        cacheUpdate<
          { conversationId: string; archived: boolean },
          ConversationState[]
        >({
          key: () => listKey,
          update: (old, vars) =>
            old?.map((c) =>
              c.id === vars.conversationId
                ? { ...c, archived: vars.archived }
                : c,
            ),
        }),
        cachePrefixUpdate<
          { conversationId: string; archived: boolean },
          ActiveConversationsResponse
        >({
          prefix: () => conversationKeys.active(),
          update: (old, vars) =>
            withActiveConversationArchived(
              old,
              vars.conversationId,
              vars.archived,
            ),
        }),
      ],
    }),
  );
}

export function useRenameConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();
  const listKey = conversationKeys.list(projectName, sessionName);

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        conversationId,
        name,
      }: {
        conversationId: string;
        name: string;
      }) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/rename`,
          "rename-conversation",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          },
        ),
      updates: [
        cacheUpdate<
          { conversationId: string; name: string },
          ConversationState[]
        >({
          key: () => listKey,
          update: (old, vars) =>
            old?.map((c) =>
              c.id === vars.conversationId ? { ...c, name: vars.name } : c,
            ),
        }),
        cachePrefixUpdate<
          { conversationId: string; name: string },
          ActiveConversationsResponse
        >({
          prefix: () => conversationKeys.active(),
          update: (old, vars) =>
            renamedInActive(old, vars.conversationId, vars.name),
        }),
      ],
    }),
  );
}

export function useAnswerQuestionMutation(
  projectName: string,
  sessionName: string,
  conversationId: string,
) {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: async ({
        questionId,
        answers,
      }: {
        questionId: string;
        answers: Record<string, AskQuestionAnswer>;
      }) => {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/answer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ questionId, answers }),
          },
        );

        if (res.ok) {
          return { status: "ok" as const };
        }

        if (res.status === 410) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          return { status: "gone" as const, error: body?.error ?? null };
        }

        throw new Error(`Answer submission failed: ${res.status}`);
      },
      updates: [
        cachePrefixUpdate<
          { questionId: string; answers: Record<string, AskQuestionAnswer> },
          ActiveConversationsResponse
        >({
          prefix: () => conversationKeys.active(),
          update: (old) =>
            old === undefined
              ? undefined
              : {
                  ...old,
                  conversations: old.conversations.map((c) =>
                    c.id === conversationId
                      ? {
                          ...c,
                          status: "running" as const,
                          pendingQuestion: null,
                          pendingQuestionId: null,
                          pendingQuestions: null,
                        }
                      : c,
                  ),
                },
        }),
        cacheUpdate<
          { questionId: string; answers: Record<string, AskQuestionAnswer> },
          SessionState
        >({
          key: () => sessionKeys.detail(projectName, sessionName),
          update: (old) =>
            old === undefined
              ? undefined
              : {
                  ...old,
                  conversations: old.conversations.map((c) =>
                    c.id === conversationId
                      ? {
                          ...c,
                          status: "running" as const,
                          pendingQuestionId: null,
                          pendingQuestions: null,
                        }
                      : c,
                  ),
                },
        }),
      ],
      invalidateKeys: () => [
        conversationKeys.messages(projectName, sessionName, conversationId),
        sessionKeys.detail(projectName, sessionName),
        conversationKeys.active(),
      ],
    }),
  );
}

/**
 * Fork a conversation at a message index.
 *
 * `profile` applies to a fork at index 0 only: that fork derives from no
 * session, so the conversation it creates is a fresh one and carries its own
 * identity. Every later index inherits the source snapshot verbatim, and the
 * route ignores a selection there — so callers send none (R7).
 *
 * Awaits the session-detail cache invalidation in onSuccess so callers that
 * navigate to the newly created conversation can rely on it being present
 * in the cache by the time the destination page mounts.
 */
export function useForkConversationMutation(
  projectName: string,
  sessionName: string,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      messageIndex,
      profile,
    }: {
      conversationId: string;
      messageIndex: number;
      profile?: AgentProfileRef;
    }) =>
      mutationFetch(
        `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/fork`,
        "fork-conversation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messageIndex,
            ...(profile === undefined ? {} : { profile }),
          }),
        },
        forkResponseSchema,
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sessionKeys.detail(projectName, sessionName),
        }),
        queryClient.invalidateQueries({
          queryKey: conversationKeys.list(projectName, sessionName),
        }),
      ]);
    },
  });
}

// ---------------------------------------------------------------------------
// Generic Conversation Mutations (project/session as variables)
// ---------------------------------------------------------------------------

/**
 * Archive/unarchive a conversation from any project/session.
 * Unlike `useArchiveConversationMutation`, this accepts project/session as
 * part of the mutation variables — useful for the active conversations tab
 * where conversations span multiple projects.
 */
export function useGenericArchiveConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (variables: GenericArchiveConversationVariables) =>
        mutationFetch(
          genericConversationMutationPath(variables, "archive"),
          "archive-conversation",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: variables.archived }),
          },
        ),
      updates: (vars) =>
        genericConversationUpdates<GenericArchiveConversationVariables>(
          vars,
          (old, v) =>
            old?.map((c) =>
              c.id === v.conversationId ? { ...c, archived: v.archived } : c,
            ),
          (old, v) =>
            withActiveConversationArchived(old, v.conversationId, v.archived),
        ),
      invalidateKeys: (vars) => genericConversationInvalidateKeys(vars),
    }),
  );
}

/**
 * Archive every other conversation in the clicked conversation's session
 * ("Archive Other Conversations"). One POST; the server decides the sibling
 * set, so the optimistic write mirrors that: all non-target session rows flip
 * to archived and drop from the active feed.
 */
export function useArchiveOtherConversationsMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (variables: {
        projectName: string;
        sessionName: string;
        conversationId: string;
      }) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(variables.projectName)}/sessions/${encodeURIComponent(variables.sessionName)}/conversations/${encodeURIComponent(variables.conversationId)}/archive-others`,
          "archive-other-conversations",
          { method: "POST" },
        ),
      updates: (vars) => [
        cacheUpdate<typeof vars, ConversationState[]>({
          key: () => conversationKeys.list(vars.projectName, vars.sessionName),
          update: (old, v) =>
            old?.map((c) =>
              c.id === v.conversationId ? c : { ...c, archived: true },
            ),
        }),
        cachePrefixUpdate<typeof vars, ActiveConversationsResponse>({
          prefix: () => conversationKeys.active(),
          update: (old, v) =>
            old === undefined
              ? undefined
              : {
                  ...old,
                  conversations: old.conversations.flatMap((c) => {
                    if (
                      c.id === v.conversationId ||
                      c.scope !== "session" ||
                      c.projectName !== v.projectName ||
                      c.sessionName !== v.sessionName
                    )
                      return [c];
                    return c.archived !== undefined
                      ? [{ ...c, archived: true }]
                      : [];
                  }),
                },
        }),
      ],
      invalidateKeys: (vars) => [
        conversationKeys.active(),
        conversationKeys.list(vars.projectName, vars.sessionName),
      ],
    }),
  );
}

/**
 * Mark a conversation as read (clear the "Needs you" pinned slot).
 *
 * Optimistically clears the `unread` flag in the active-conversations cache
 * so the sidebar drops the amber accent before the server round-trip.
 */
export function useMarkConversationReadMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: ({
        projectName,
        sessionName,
        conversationId,
      }: {
        projectName: string;
        sessionName: string;
        conversationId: string;
      }) =>
        mutationFetch(
          `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/mark-read`,
          "mark-conversation-read",
          { method: "POST" },
        ),
      updates: [
        cachePrefixUpdate<
          { projectName: string; sessionName: string; conversationId: string },
          ActiveConversationsResponse
        >({
          prefix: () => conversationKeys.active(),
          update: (old, vars) =>
            old === undefined
              ? undefined
              : {
                  ...old,
                  conversations: old.conversations.map((c) =>
                    c.id === vars.conversationId ? { ...c, unread: false } : c,
                  ),
                },
        }),
      ],
    }),
  );
}

/**
 * Rename a conversation from any project/session.
 * Accepts project/session as part of the mutation variables.
 */
export function useGenericRenameConversationMutation() {
  const queryClient = useQueryClient();

  return useMutation(
    createOptimisticMutation(queryClient, {
      mutationFn: (variables: GenericRenameConversationVariables) =>
        mutationFetch(
          genericConversationMutationPath(variables, "rename"),
          "rename-conversation",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: variables.name }),
          },
        ),
      updates: (vars) =>
        genericConversationUpdates<GenericRenameConversationVariables>(
          vars,
          (old, v) =>
            old?.map((c) =>
              c.id === v.conversationId ? { ...c, name: v.name } : c,
            ),
          (old, v) => renamedInActive(old, v.conversationId, v.name),
        ),
      invalidateKeys: (vars) => genericConversationInvalidateKeys(vars),
    }),
  );
}

export function useGenerateConversationNameMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: GenericGenerateConversationNameVariables) =>
      mutationFetch(
        genericConversationMutationPath(variables, "generate-name"),
        "generate-conversation-name",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            variables.messageIndex === undefined
              ? { source: "conversation" }
              : { source: "message", messageIndex: variables.messageIndex },
          ),
        },
        generateConversationNameResponseSchema,
      ),
    onSuccess: ({ name }, variables) => {
      const patchList = (old: ConversationState[] | undefined) =>
        old?.map((conversation) =>
          conversation.id === variables.conversationId
            ? { ...conversation, name }
            : conversation,
        );
      const updates = genericConversationUpdates(
        variables,
        patchList,
        (old) => renamedInActive(old, variables.conversationId, name),
        patchList,
      );
      for (const update of updates) {
        update.apply(queryClient, variables);
      }
    },
    onError: () => {
      pushToast("Couldn't generate a conversation name");
    },
    onSettled: (_data, _error, variables) => {
      for (const queryKey of genericConversationInvalidateKeys(variables)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/** Review changes are reconciled from durable state even if the response is lost. */
export function useReviewQueuedMessageMutation(
  target: ConversationTarget | null,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: QueueReviewAction }) => {
      if (!target)
        throw new Error("A conversation is required for queue review");
      return mutationFetch(
        `${conversationTargetApiBase(target)}/queue/${encodeURIComponent(id)}`,
        "review-queued-message",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
        queueReviewResponseSchema,
      );
    },
    onSettled: async () => {
      if (!target) return;
      const keys: QueryKey[] = [...genericConversationInvalidateKeys(target)];
      if (target.scope === "session")
        keys.push(sessionKeys.detail(target.projectName, target.sessionName));
      await Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}
