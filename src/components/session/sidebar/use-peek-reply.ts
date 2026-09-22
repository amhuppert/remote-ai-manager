import { useMutation, useQueryClient } from "@tanstack/react-query";
import { streamingMutationFetch } from "@/lib/api/fetcher";
import { conversationKeys } from "@/lib/conversations/query-keys";
import type { ImagePayload } from "@/lib/images/schemas";
import type { RunPromptRequest } from "@/lib/prompt/schemas";
import { collaborationKeys } from "@/lib/workflows/query-keys";
import {
  type CollabConfigDraft,
  useClearCollabConfigDraftIfMatches,
} from "@/stores/collaboration.store";

export type PeekCollabConfig = NonNullable<RunPromptRequest["collab"]>;

export interface PeekReplyLogger {
  info(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export interface PeekReplyDeps {
  fetcher(
    url: string,
    traceLabel: string,
    options: RequestInit,
  ): Promise<unknown>;
  logger: PeekReplyLogger;
}

export interface PeekReplyParams {
  projectName: string;
  sessionName: string;
  conversationId: string;
  text: string;
  images?: ImagePayload[];
  collab?: PeekCollabConfig;
}

interface OrdinaryPeekReplyMutationVariables {
  text: string;
  images?: ImagePayload[];
  collab?: undefined;
  collabDraft?: undefined;
}

interface CollaborationPeekReplyMutationVariables {
  text: string;
  images?: ImagePayload[];
  collab: PeekCollabConfig;
  collabDraft: CollabConfigDraft;
}

type PeekReplyMutationVariables =
  | OrdinaryPeekReplyMutationVariables
  | CollaborationPeekReplyMutationVariables;

export interface UsePeekReplyParams {
  projectName: string;
  sessionName: string;
  conversationId: string;
}

export const peekReplyKeys = {
  submit: (projectName: string, sessionName: string, conversationId: string) =>
    ["peek-reply", projectName, sessionName, conversationId] as const,
};

const promptUrl = ({
  projectName,
  sessionName,
  conversationId,
}: Pick<
  PeekReplyParams,
  "projectName" | "sessionName" | "conversationId"
>): string =>
  `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/prompt`;

export const createPeekReplySubmitter =
  (deps: PeekReplyDeps) =>
  async ({
    projectName,
    sessionName,
    conversationId,
    text,
    images,
    collab,
  }: PeekReplyParams): Promise<unknown> => {
    const trimmed = text.trim();
    const url = promptUrl({ projectName, sessionName, conversationId });

    deps.logger.info("peek_reply.submit", {
      projectName,
      sessionName,
      conversationId,
      textLength: trimmed.length,
      collaborationRequested: collab !== undefined,
    });

    try {
      const result = await deps.fetcher(url, "peek-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          ...(images?.length ? { images } : {}),
          ...(collab !== undefined ? { collab } : {}),
        }),
      });
      deps.logger.info("peek_reply.success", {
        projectName,
        sessionName,
        conversationId,
      });
      return result;
    } catch (error) {
      deps.logger.error("peek_reply.failure", {
        projectName,
        sessionName,
        conversationId,
        error,
      });
      throw error;
    }
  };

const browserLogger: PeekReplyLogger = {
  info(message, fields) {
    console.debug("[features/session/sidebar/use-peek-reply]", message, fields);
  },
  error(message, fields) {
    console.error("[features/session/sidebar/use-peek-reply]", message, fields);
  },
};

const productionDeps: PeekReplyDeps = {
  fetcher: streamingMutationFetch,
  logger: browserLogger,
};

const productionSubmitPeekReply = createPeekReplySubmitter(productionDeps);

export function usePeekReply({
  projectName,
  sessionName,
  conversationId,
}: UsePeekReplyParams) {
  const queryClient = useQueryClient();
  const clearCollabConfigDraftIfMatches = useClearCollabConfigDraftIfMatches();

  return useMutation({
    mutationKey: peekReplyKeys.submit(projectName, sessionName, conversationId),
    mutationFn: ({ text, images, collab }: PeekReplyMutationVariables) =>
      productionSubmitPeekReply({
        projectName,
        sessionName,
        conversationId,
        text,
        images,
        collab,
      }),
    onSuccess: (_result, variables) => {
      if (variables.collab !== undefined) {
        clearCollabConfigDraftIfMatches(
          projectName,
          sessionName,
          conversationId,
          variables.collabDraft,
        );
        void queryClient.invalidateQueries({
          queryKey: collaborationKeys.all,
        });
      }
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.messages(
          projectName,
          sessionName,
          conversationId,
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: conversationKeys.active(),
      });
    },
  });
}
