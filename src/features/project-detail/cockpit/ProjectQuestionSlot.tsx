"use client";

import { useCallback, useState, type ReactNode } from "react";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { pushToast } from "@/stores/toast.store";
import { useAnswerProjectQuestionMutation } from "@/lib/project-conversations-client/mutations";
import type {
  AskQuestionAnswer,
  ConversationState,
} from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface ProjectQuestionSlotProps {
  projectName: string;
  /** The cockpit's active conversation, as the server reports it. */
  conversation: ConversationState | undefined;
  /** Asking agent — drives the panel's accent color. */
  agentBackend: AgentBackendId;
  /** Rendered when no question is pending. */
  composer: ReactNode;
}

/**
 * The project cockpit's bottom slot: the shared question panel while the active
 * conversation has a pending batch, the composer otherwise. Mirrors the session
 * page's `PromptInputSlot` precedence (a question takes the composer's place),
 * minus the approval gate and workflow-managed read-only treatment — neither
 * exists at project scope.
 *
 * The question is read from the conversation's DURABLE fields rather than from
 * a live-event slot, so it is the same whether it arrived on this tab's own
 * prompt stream, over SSE from another client, or from the first fetch after a
 * reload. That is what makes a question survive the page it was asked on.
 */
export default function ProjectQuestionSlot({
  projectName,
  conversation,
  agentBackend,
  composer,
}: ProjectQuestionSlotProps): React.JSX.Element {
  const questionId = conversation?.pendingQuestionId ?? null;
  const questions = conversation?.pendingQuestions ?? null;
  const conversationId = conversation?.id ?? "";

  const [currentIndex, setCurrentIndex] = useState(0);
  const isMobile = useIsMobile();
  const answerMutation = useAnswerProjectQuestionMutation(
    projectName,
    conversationId,
  );

  const handleSubmit = useCallback(
    async (batchId: string, answers: Record<string, AskQuestionAnswer>) => {
      try {
        const result = await answerMutation.mutateAsync({
          questionId: batchId,
          answers,
        });
        if (result.status === "gone") {
          // The batch was answered or superseded elsewhere. The optimistic
          // clear already took the panel down; say why, so the answer does not
          // just appear to vanish.
          pushToast(
            result.error ??
              "That question was already answered or has been superseded.",
          );
        }
      } catch {
        // Best effort: the optimistic rollback restores the pending batch, so
        // the panel stays up and the user can retry.
      }
    },
    [answerMutation],
  );

  if (questionId === null || questions === null || questions.length === 0) {
    return <>{composer}</>;
  }

  return (
    <AskQuestionPanel
      // Re-keyed per batch so a new question starts with clean drafts.
      key={questionId}
      questions={questions}
      questionId={questionId}
      currentIndex={currentIndex}
      onNavigate={setCurrentIndex}
      onSubmit={handleSubmit}
      agent={agentBackend}
      compact={isMobile}
      voiceProjectName={projectName}
    />
  );
}
