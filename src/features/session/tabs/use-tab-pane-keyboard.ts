"use client";

import { useMemo } from "react";
import { useOrderedConversationHotkeys } from "@/hooks/use-ordered-conversation-hotkeys";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { LayoutMode } from "@/lib/sessions/schemas";
import {
  scheduleActivePromptFocus,
  shouldRestoreActivePromptFocus,
} from "@/lib/hotkeys/prompt-focus";

/**
 * Binds working-set navigation and the command-launcher-only panes exit action.
 * The dispatcher owns overlay precedence and records every successful command
 * invocation without exposing conversation content.
 */
export function useTabPaneKeyboard(input: {
  workingSet: SessionActiveConversation[];
  activeId: string | null;
  activate: (id: string) => void;
  closeTab: (id: string) => void;
  layout: LayoutMode;
  onEnterPanes: () => void;
  onExitPanes: () => void;
}): void {
  const {
    workingSet,
    activeId,
    activate,
    closeTab,
    layout,
    onEnterPanes,
    onExitPanes,
  } = input;
  const orderedIds = useMemo(
    () => workingSet.map((conversation) => conversation.id),
    [workingSet],
  );
  const hasActiveTab = activeId !== null && orderedIds.includes(activeId);

  useOrderedConversationHotkeys({
    orderedIds,
    activeId,
    activate,
  });
  useAppHotkey(
    "closeConversationTab",
    (event, invocation) => {
      if (!hasActiveTab || activeId === null) return;
      const restorePromptFocus = shouldRestoreActivePromptFocus(
        event.target,
        invocation.context,
      );
      closeTab(activeId);
      if (layout === "panes" && workingSet.length === 1) {
        onExitPanes();
      }
      if (restorePromptFocus) scheduleActivePromptFocus();
    },
    { enabled: hasActiveTab },
  );
  useAppHotkey("viewPanes", () => onEnterPanes(), {
    enabled: layout !== "panes" && workingSet.length >= 2,
  });
  useAppHotkey("exitPanes", () => onExitPanes(), {
    enabled: layout === "panes",
  });
}
