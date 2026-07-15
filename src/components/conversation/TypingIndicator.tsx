"use client";

import { memo } from "react";
import { cn } from "@/lib/ui/cn";
import { messageRoleClass } from "@/components/conversation/MessageRow";
import { backendLabel, backendToneToken } from "@/lib/agent-backends/catalog";
import { useOptimisticMessagesFor } from "@/stores/session-detail.store";
import type { AgentBackendId } from "@/lib/shared/schemas";
interface TypingIndicatorProps {
  /**
   * The conversation this indicator renders for. In-flight state is keyed per
   * conversation, so the indicator reads its own conversation's optimistic
   * stream to pick the visual variant — any surface (panel, pane, peek,
   * cockpit) gets the correct variant for the conversation it shows.
   */
  conversationId: string;
  selectedBackend: AgentBackendId;
  /**
   * Whether the indicator should be visible at all. The parent computes this
   * from `sending`, `displayStatus`, and collab activity — the indicator only
   * decides which visual variant to render based on optimistic-message state.
   */
  visible: boolean;
}

const dotClass =
  "block w-[6px] h-[6px] rounded-full animate-[typingBounce_1.2s_ease-in-out_infinite]";

// `streaming-indicator` and `typing-indicator` are retained purely as test hooks
// (ConversationWorkspace + ProjectTranscriptHost query them); `message assistant`
// mirror the row hooks. The indicators' own appearance is utilities.
function TypingIndicator({
  conversationId,
  selectedBackend,
  visible,
}: TypingIndicatorProps): React.JSX.Element | null {
  const optimisticMessages = useOptimisticMessagesFor(conversationId);
  if (!visible) return null;

  const isVioletTone = backendToneToken(selectedBackend) === "violet";
  const dotColor = isVioletTone ? "bg-violet" : "bg-cyan";
  const dots = (
    <div className="flex items-center gap-[4px] py-[4px]">
      <span className={cn(dotClass, dotColor)} />
      <span className={cn(dotClass, dotColor, "[animation-delay:0.15s]")} />
      <span className={cn(dotClass, dotColor, "[animation-delay:0.3s]")} />
    </div>
  );

  const hasAssistantOptimistic = optimisticMessages.some(
    (m) => m.role === "assistant",
  );
  if (hasAssistantOptimistic) {
    return (
      <div
        className="streaming-indicator flex animate-fade-in py-[4px] pr-0 pl-md"
        data-backend={selectedBackend}
      >
        {dots}
      </div>
    );
  }
  return (
    <div
      className="message assistant typing-indicator relative animate-fade-in"
      data-backend={selectedBackend}
    >
      <div
        className={cn(
          messageRoleClass,
          isVioletTone ? "text-violet" : "text-cyan",
        )}
      >
        {backendLabel(selectedBackend)}
      </div>
      <div className="message-content">{dots}</div>
    </div>
  );
}

export default memo(TypingIndicator);
