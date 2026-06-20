"use client";

import { cn } from "@/lib/ui/cn";
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
      data-on={isActive}
      className={cn(
        "group flex h-[36px] items-center gap-[6px] rounded-md border border-solid px-[12px] font-mono text-[0.72rem] font-medium whitespace-nowrap transition-all duration-150 ease-[ease]",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "data-[on=false]:border-border-default data-[on=false]:bg-bg-surface data-[on=false]:text-text-secondary",
        "data-[on=false]:hover:border-border-strong data-[on=false]:hover:bg-bg-hover data-[on=false]:hover:text-text-primary",
        "data-[on=true]:border-[var(--cc-amber-a40)] data-[on=true]:bg-amber-glow data-[on=true]:text-amber",
        "data-[on=true]:hover:border-amber-dim data-[on=true]:hover:bg-[var(--cc-amber-a20)]",
      )}
      onClick={() => toggleMutation.mutate(isActive ? "exit" : "enter")}
      disabled={disabled || toggleMutation.isPending}
      data-tooltip={isActive ? "Exit debug mode" : "Enter debug mode"}
      aria-pressed={isActive}
    >
      <span className="size-[6px] shrink-0 rounded-full bg-text-tertiary transition-all duration-200 ease-[ease] group-data-[on=true]:bg-amber group-data-[on=true]:shadow-[0_0_6px_var(--color-amber)]" />
      <span>Debug</span>
    </button>
  );
}
