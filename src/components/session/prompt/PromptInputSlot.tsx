"use client";
import { type ComponentProps } from "react";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import { IterationReadonlyBanner } from "@/components/conversation/ConversationBanners";
import PromptComposer from "@/components/session/prompt/PromptComposer";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { AgentBackendId } from "@/lib/shared/schemas";
type AskQuestionPanelProps = ComponentProps<typeof AskQuestionPanel>;
export interface PromptSlotView {
  content: "readonly" | "questions" | "composer";
}
export function resolvePromptSlotView({
  isWorkflowManagedConversation,
  hasPendingQuestions,
}: {
  isWorkflowManagedConversation: boolean;
  hasPendingQuestions: boolean;
}): PromptSlotView {
  return {
    content: isWorkflowManagedConversation
      ? "readonly"
      : hasPendingQuestions
        ? "questions"
        : "composer",
  };
}
export interface PromptInputSlotProps {
  isWorkflowManagedConversation: boolean;
  pendingQuestions: AskQuestionPanelProps["questions"] | null;
  pendingQuestionId: string | null;
  currentQuestionIndex: number;
  navigateQuestion: AskQuestionPanelProps["onNavigate"];
  handleAnswerSubmit: AskQuestionPanelProps["onSubmit"];
  agentBackend: AgentBackendId;
  promptComposerProps: ComponentProps<typeof PromptComposer>;
}
export default function PromptInputSlot({
  isWorkflowManagedConversation,
  pendingQuestions,
  pendingQuestionId,
  currentQuestionIndex,
  navigateQuestion,
  handleAnswerSubmit,
  agentBackend,
  promptComposerProps,
}: PromptInputSlotProps): React.JSX.Element {
  const isMobile = useIsMobile();
  const view = resolvePromptSlotView({
    isWorkflowManagedConversation,
    hasPendingQuestions: Boolean(pendingQuestions && pendingQuestionId),
  });
  if (view.content === "readonly") return <IterationReadonlyBanner />;
  if (view.content === "questions" && pendingQuestions && pendingQuestionId)
    return (
      <AskQuestionPanel
        key={pendingQuestionId}
        questions={pendingQuestions}
        questionId={pendingQuestionId}
        currentIndex={currentQuestionIndex}
        onNavigate={navigateQuestion}
        onSubmit={handleAnswerSubmit}
        agent={agentBackend}
        compact={isMobile}
      />
    );
  return <PromptComposer {...promptComposerProps} />;
}
