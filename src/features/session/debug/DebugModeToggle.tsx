"use client";

import { useDebugModeToggleMutation } from "@/lib/debug-log/mutations";
import type { ConversationState } from "@/lib/conversations/schemas";
interface DebugModeToggleProps {
  projectName: string;
  sessionName: string;
  conversation: ConversationState | undefined;
  disabled?: boolean;
}

export default function DebugModeToggle({
  projectName,
  sessionName,
  conversation,
  disabled = false,
}: DebugModeToggleProps): React.JSX.Element | null {
  const conversationId = conversation?.id ?? "";

  const toggleMutation = useDebugModeToggleMutation(
    projectName,
    sessionName,
    conversationId,
  );

  if (!conversation) return null;

  const isActive = conversation.debugMode?.active ?? false;

  return (
    <button
      type="button"
      className={`debug-toggle${isActive ? " debug-toggle--on" : ""}`}
      onClick={() => toggleMutation.mutate(isActive ? "exit" : "enter")}
      disabled={disabled || toggleMutation.isPending}
      data-tooltip={isActive ? "Exit debug mode" : "Enter debug mode"}
      aria-pressed={isActive}
    >
      <span className="debug-toggle__dot" />
      <span className="debug-toggle__label">Debug</span>
    </button>
  );
}
