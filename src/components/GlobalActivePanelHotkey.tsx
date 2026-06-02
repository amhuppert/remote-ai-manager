"use client";

import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useToggleUnifiedPanel } from "@/stores/unified-panel.store";

/**
 * Registers the global Shift+B hotkey that toggles the unified
 * (active conversations / notifications) panel. Renders nothing.
 */
export default function GlobalActivePanelHotkey(): React.JSX.Element | null {
  const toggle = useToggleUnifiedPanel();
  useAppHotkey("toggleActivePanel", toggle);
  return null;
}
