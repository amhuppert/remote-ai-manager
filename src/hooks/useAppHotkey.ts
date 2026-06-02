"use client";

import { useHotkeys } from "react-hotkeys-hook";
import { HOTKEY_REGISTRY, type HotkeyId } from "@/lib/shared/hotkeys";
import { useIsOverlayOpen } from "@/stores/overlay-scope.store";

export function useAppHotkey(
  id: HotkeyId,
  callback: (event: KeyboardEvent) => void,
  options?: { enabled?: boolean; keepActiveInOverlay?: boolean },
): void {
  const def = HOTKEY_REGISTRY[id];
  const overlayOpen = useIsOverlayOpen();

  // Page hotkeys are suppressed while any overlay (modal/drawer/menu/popover)
  // is open. Overlay-owned hotkeys opt out with `keepActiveInOverlay`.
  const enabled =
    (options?.enabled ?? true) &&
    (options?.keepActiveInOverlay ? true : !overlayOpen);

  useHotkeys(def.keys, callback, {
    preventDefault: true,
    enabled,
    enableOnFormTags: def.enableOnFormTags
      ? (["input", "textarea", "select"] as const)
      : undefined,
    enableOnContentEditable: def.enableOnContentEditable,
    useKey: def.useKey,
  });
}
