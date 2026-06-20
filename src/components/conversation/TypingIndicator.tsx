"use client";

import { memo } from "react";
import { cn } from "@/lib/ui/cn";
import { messageRoleClass } from "@/components/conversation/MessageRow";
import { useOptimisticMessages } from "@/stores/session-detail.store";
import type { AgentBackendId } from "@/lib/shared/schemas";
interface TypingIndicatorProps {
  selectedBackend: AgentBackendId;
  /**
   * Whether the indicator should be visible at all. The parent computes this
   * from `sending`, `displayStatus`, and collab activity — the indicator only
   * decides which visual variant to render based on optimistic-message state.
   */
  visible: boolean;
  /**
   * Override the session-detail store's optimistic-message check. The default
   * reads `useOptimisticMessages()` which is keyed to the currently-mounted
   * conversation — callers rendering for a *different* conversation (e.g. the
   * sidebar peek popover) must pass `false` explicitly so the store does not
   * leak the active conversation's optimistic state into the peek.
   */
  hasAssistantOptimistic?: boolean;
}

const dotClass =
  "block w-[6px] h-[6px] rounded-full animate-[typingBounce_1.2s_ease-in-out_infinite]";

// `streaming-indicator` and `typing-indicator` are retained purely as test hooks
// (ConversationWorkspace + ProjectTranscriptHost query them); `message assistant`
// mirror the row hooks. The indicators' own appearance is utilities.
function TypingIndicator({
  selectedBackend,
  visible,
  hasAssistantOptimistic: hasAssistantOptimisticOverride,
}: TypingIndicatorProps): React.JSX.Element | null {
  const optimisticMessages = useOptimisticMessages();
  if (!visible) return null;

  const isCodex = selectedBackend === "codex";
  const dotColor = isCodex ? "bg-violet" : "bg-cyan";
  const dots = (
    <div className="flex items-center gap-[4px] py-[4px]">
      <span className={cn(dotClass, dotColor)} />
      <span className={cn(dotClass, dotColor, "[animation-delay:0.15s]")} />
      <span className={cn(dotClass, dotColor, "[animation-delay:0.3s]")} />
    </div>
  );

  const hasAssistantOptimistic =
    hasAssistantOptimisticOverride ??
    optimisticMessages.some((m) => m.role === "assistant");
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
        className={cn(messageRoleClass, isCodex ? "text-violet" : "text-cyan")}
      >
        {isCodex ? "Codex" : "Claude"}
      </div>
      <div className="message-content">{dots}</div>
    </div>
  );
}

export default memo(TypingIndicator);
