"use client";

import { type ComponentProps, type RefObject } from "react";
import ApprovalGatePanel from "@/components/ApprovalGatePanel";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import { IterationReadonlyBanner } from "@/components/conversation/ConversationBanners";
import PromptComposer from "@/features/session/prompt/PromptComposer";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { AgentBackendId } from "@/lib/shared/schemas";

type PromptComposerProps = ComponentProps<typeof PromptComposer>;
type AskQuestionPanelProps = ComponentProps<typeof AskQuestionPanel>;
type ApprovalGatePanelProps = ComponentProps<typeof ApprovalGatePanel>;

export interface PromptSlotView {
  showApprovalGate: boolean;
  content: "readonly" | "questions" | "composer";
}

/**
 * Branch selection for the prompt slot. While an undecided approval gate is
 * standing, the workflow-managed read-only treatment is bypassed so the user
 * can chat alongside the gate panel (requirement 6.1); pending questions keep
 * precedence over the composer but render below the gate panel.
 */
export function resolvePromptSlotView({
  hasApprovalGate,
  isWorkflowManagedConversation,
  hasPendingQuestions,
}: {
  hasApprovalGate: boolean;
  isWorkflowManagedConversation: boolean;
  hasPendingQuestions: boolean;
}): PromptSlotView {
  if (!hasApprovalGate && isWorkflowManagedConversation) {
    return { showApprovalGate: false, content: "readonly" };
  }
  return {
    showApprovalGate: hasApprovalGate,
    content: hasPendingQuestions ? "questions" : "composer",
  };
}

export interface PromptInputSlotProps {
  isWorkflowManagedConversation: boolean;
  approvalGate: ApprovalGatePanelProps | null;
  pendingQuestions: AskQuestionPanelProps["questions"] | null;
  pendingQuestionId: string | null;
  currentQuestionIndex: number;
  navigateQuestion: AskQuestionPanelProps["onNavigate"];
  handleAnswerSubmit: AskQuestionPanelProps["onSubmit"];
  /** Asking agent — drives the question panel's accent color. */
  agentBackend: AgentBackendId;
  promptComposerProps: PromptComposerProps;
}

export default function PromptInputSlot({
  isWorkflowManagedConversation,
  approvalGate,
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
    hasApprovalGate: approvalGate !== null,
    isWorkflowManagedConversation,
    hasPendingQuestions: Boolean(pendingQuestions && pendingQuestionId),
  });

  if (view.content === "readonly") {
    return <IterationReadonlyBanner />;
  }

  const gatePanel =
    view.showApprovalGate && approvalGate !== null ? (
      <ApprovalGatePanel {...approvalGate} />
    ) : null;

  if (view.content === "questions" && pendingQuestions && pendingQuestionId) {
    return (
      <>
        {gatePanel}
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
      </>
    );
  }
  return (
    <>
      {gatePanel}
      <PromptComposer {...promptComposerProps} />
    </>
  );
}

export type { RefObject };
