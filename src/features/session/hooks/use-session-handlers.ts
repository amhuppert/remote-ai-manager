"use client";

import { useCallback } from "react";
import type { useRouter } from "next/navigation";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AskQuestionAnswer } from "@/lib/conversations/schemas";
import { buildConversationContext } from "@/lib/conversations/copy-context";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
import { useGraphWorkflowExecutionQuery } from "@/lib/workflows/queries";

interface AnswerMutation {
  mutateAsync: (input: {
    questionId: string;
    answers: Record<string, AskQuestionAnswer>;
  }) => Promise<
    | { status: "ok"; error?: undefined }
    | { status: "gone"; error: string | null }
  >;
}

interface DeleteMutation {
  mutate: (sessionName: string, opts: { onSuccess: () => void }) => void;
}

interface ForkMutation {
  mutateAsync: (input: {
    conversationId: string;
    messageIndex: number;
  }) => Promise<{ conversationId: string }>;
}

export interface UseSessionHandlersArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  session: SessionState | undefined;
  router: ReturnType<typeof useRouter>;
  answerMutation: AnswerMutation;
  deleteMutation: DeleteMutation;
  forkMutation: ForkMutation;
  cancelDelete: () => void;
  clearQuestions: () => void;
  failPrompt: (message: string) => void;
  /**
   * When provided, invoked instead of `router.push` for conversation switches
   * originating inside the workspace (e.g. opening a fork), so a host like
   * /conversations can switch in place with the history API (§1.2). When
   * absent, behavior is the per-conversation route's `router.push`.
   */
  onOpenConversation?: (target: { conversationId: string }) => void;
}

export interface SessionHandlers {
  handleAnswerSubmit: (
    questionId: string,
    answers: Record<string, AskQuestionAnswer>,
  ) => Promise<void>;
  handleDelete: () => void;
  handleFork: (messageIndex: number) => Promise<void>;
  buildContext: () => string | null;
}

export function useSessionHandlers({
  projectName,
  sessionName,
  conversationId,
  session,
  router,
  answerMutation,
  deleteMutation,
  forkMutation,
  cancelDelete,
  clearQuestions,
  failPrompt,
  onOpenConversation,
}: UseSessionHandlersArgs): SessionHandlers {
  const graphWorkflowExecutionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );

  const handleAnswerSubmit = useCallback(
    async (questionId: string, answers: Record<string, AskQuestionAnswer>) => {
      try {
        const result = await answerMutation.mutateAsync({
          questionId,
          answers,
        });
        if (result.status === "ok") {
          clearQuestions();
        } else {
          clearQuestions();
          failPrompt(
            result.error ??
              "The prompt that asked this question is no longer running.",
          );
        }
      } catch {
        // Best effort — the question panel remains visible for retry
      }
    },
    [clearQuestions, failPrompt, answerMutation],
  );

  const handleDelete = useCallback(() => {
    cancelDelete();
    deleteMutation.mutate(sessionName, {
      onSuccess: () => {
        router.push(`/projects/${encodeURIComponent(projectName)}`);
      },
    });
  }, [deleteMutation, sessionName, projectName, router, cancelDelete]);

  const handleFork = useCallback(
    async (messageIndex: number) => {
      try {
        const result = await forkMutation.mutateAsync({
          conversationId,
          messageIndex,
        });
        if (onOpenConversation !== undefined) {
          onOpenConversation({ conversationId: result.conversationId });
        } else {
          router.push(
            conversationsPageHref({ conversationId: result.conversationId }),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Fork failed";
        failPrompt(message);
      }
    },
    [forkMutation, conversationId, router, failPrompt, onOpenConversation],
  );

  const buildContext = useCallback((): string | null => {
    if (!session) return null;
    return buildConversationContext({
      projectName,
      sessionName,
      session,
      conversationId,
      graphWorkflowExecution: graphWorkflowExecutionQuery.data ?? null,
    });
  }, [
    session,
    conversationId,
    projectName,
    sessionName,
    graphWorkflowExecutionQuery.data,
  ]);

  return { handleAnswerSubmit, handleDelete, handleFork, buildContext };
}
