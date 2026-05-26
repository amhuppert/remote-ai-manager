"use client";

import { type ComponentProps, type RefObject } from "react";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import { IterationReadonlyBanner } from "@/components/conversation/ConversationBanners";
import PromptComposer from "@/features/session/prompt/PromptComposer";

type PromptComposerProps = ComponentProps<typeof PromptComposer>;
type AskQuestionPanelProps = ComponentProps<typeof AskQuestionPanel>;

export interface PromptInputSlotProps {
  isWorkflowManagedConversation: boolean;
  pendingQuestions: AskQuestionPanelProps["questions"] | null;
  pendingQuestionId: string | null;
  currentQuestionIndex: number;
  navigateQuestion: AskQuestionPanelProps["onNavigate"];
  handleAnswerSubmit: AskQuestionPanelProps["onSubmit"];
  promptComposerProps: PromptComposerProps;
}

export default function PromptInputSlot({
  isWorkflowManagedConversation,
  pendingQuestions,
  pendingQuestionId,
  currentQuestionIndex,
  navigateQuestion,
  handleAnswerSubmit,
  promptComposerProps,
}: PromptInputSlotProps): React.JSX.Element {
  if (isWorkflowManagedConversation) {
    return <IterationReadonlyBanner />;
  }
  if (pendingQuestions && pendingQuestionId) {
    return (
      <AskQuestionPanel
        questions={pendingQuestions}
        questionId={pendingQuestionId}
        currentIndex={currentQuestionIndex}
        onNavigate={navigateQuestion}
        onSubmit={handleAnswerSubmit}
      />
    );
  }
  return <PromptComposer {...promptComposerProps} />;
}

export type { RefObject };
