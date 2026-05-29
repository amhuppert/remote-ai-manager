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
  /**
   * Override the session-detail store's optimistic-message check. The default
   * reads `useOptimisticMessages()` which is keyed to the currently-mounted
   * conversation — callers rendering for a *different* conversation (e.g. the
   * sidebar peek popover) must pass `false` explicitly so the store does not
   * leak the active conversation's optimistic state into the peek.
   */
  hasAssistantOptimistic?: boolean;
}

function TypingIndicator({
  selectedBackend,
  visible,
  hasAssistantOptimistic: hasAssistantOptimisticOverride,
}: TypingIndicatorProps): React.JSX.Element | null {
  const optimisticMessages = useOptimisticMessages();
  if (!visible) return null;

  const hasAssistantOptimistic =
    hasAssistantOptimisticOverride ??
    optimisticMessages.some((m) => m.role === "assistant");
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
