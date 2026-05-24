"use client";

import { useHotkeys } from "react-hotkeys-hook";
import { HOTKEY_REGISTRY, type HotkeyId } from "@/lib/shared/hotkeys";

export function useAppHotkey(
  id: HotkeyId,
  callback: (event: KeyboardEvent) => void,
  options?: { enabled?: boolean },
): void {
  const def = HOTKEY_REGISTRY[id];

  useHotkeys(def.keys, callback, {
    preventDefault: true,
    enabled: options?.enabled,
    enableOnFormTags: def.enableOnFormTags
      ? (["input", "textarea", "select"] as const)
      : undefined,
    enableOnContentEditable: def.enableOnContentEditable,
    useKey: def.useKey,
  });
}
