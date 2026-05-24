"use client";

import { useCallback } from "react";
import type { useRouter } from "next/navigation";
import type { SessionState } from "@/lib/sessions/schemas";
import { buildConversationContext } from "@/lib/conversations/copy-context";

interface AnswerMutation {
  mutateAsync: (input: {
    questionId: string;
    answers: Record<string, string>;
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
}

export interface SessionHandlers {
  handleAnswerSubmit: (
    questionId: string,
    answers: Record<string, string>,
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
}: UseSessionHandlersArgs): SessionHandlers {
  const handleAnswerSubmit = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
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
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/${result.conversationId}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Fork failed";
        failPrompt(message);
      }
    },
    [
      forkMutation,
      projectName,
      sessionName,
      conversationId,
      router,
      failPrompt,
    ],
  );

  const buildContext = useCallback((): string | null => {
    if (!session) return null;
    return buildConversationContext({
      projectName,
      sessionName,
      session,
      conversationId,
    });
  }, [session, conversationId, projectName, sessionName]);

  return { handleAnswerSubmit, handleDelete, handleFork, buildContext };
}
