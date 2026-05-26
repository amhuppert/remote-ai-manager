"use client";

import { memo } from "react";
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
}

function TypingIndicator({
  selectedBackend,
  visible,
}: TypingIndicatorProps): React.JSX.Element | null {
  const optimisticMessages = useOptimisticMessages();
  if (!visible) return null;

  const hasAssistantOptimistic = optimisticMessages.some(
    (m) => m.role === "assistant",
  );
  if (hasAssistantOptimistic) {
    return (
      <div className="streaming-indicator" data-backend={selectedBackend}>
        <div className="typing-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  return (
    <div
      className="message assistant typing-indicator"
      data-backend={selectedBackend}
    >
      <div className="message-role">
        {selectedBackend === "codex" ? "Codex" : "Claude"}
      </div>
      <div className="message-content">
        <div className="typing-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

export default memo(TypingIndicator);
