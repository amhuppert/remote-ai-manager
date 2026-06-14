"use client";

import { useCallback } from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { LayoutMode } from "@/lib/sessions/schemas";

/**
 * Binds the tab/panes keyboard shortcuts (R8):
 * - `mod+1…mod+9` activates the Nth open conversation (works in every layout).
 * - `Escape` exits the panes layout (only while `layout === "panes"`).
 *
 * Overlay-first precedence (R8.3) is automatic: `useAppHotkey` disables both
 * hotkeys whenever a peek popover or context menu is open, so Escape closes the
 * overlay first and never also exits panes on the same press. No bespoke
 * `defaultPrevented` handling is required here.
 */
export function useTabPaneKeyboard(input: {
  workingSet: SessionActiveConversation[];
  activate: (id: string) => void;
  layout: LayoutMode;
  onExitPanes: () => void;
}): void {
  const { workingSet, activate, layout, onExitPanes } = input;

  const onActivate = useCallback(
    (event: KeyboardEvent) => {
      // The combo list binds mod+1…mod+9; the pressed digit lives in event.key.
      const n = Number.parseInt(event.key, 10);
      if (Number.isNaN(n) || n < 1 || n > 9) return;
      const target = workingSet[n - 1];
      if (target) activate(target.id);
    },
    [workingSet, activate],
  );

  useAppHotkey("activateOpenTab", onActivate);
  useAppHotkey("exitPanes", () => onExitPanes(), {
    enabled: layout === "panes",
  });
}
