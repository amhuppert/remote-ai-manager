"use client";

import { useCallback } from "react";
import {
  getAdjacentOrderedId,
  getOrderedIdForShortcut,
} from "@/lib/hotkeys/ordered-id-navigation";
import { useAppHotkey } from "./useAppHotkey";

export function useOrderedConversationHotkeys(input: {
  readonly orderedIds: readonly string[];
  readonly activeId: string | null;
  readonly activate: (id: string) => void;
  readonly enabled?: boolean;
}): void {
  const { orderedIds, activeId, activate, enabled = true } = input;

  const activateByPosition = useCallback(
    (event: KeyboardEvent) => {
      const targetId = getOrderedIdForShortcut(orderedIds, event.key);
      if (targetId !== null) activate(targetId);
    },
    [activate, orderedIds],
  );
  const activateAdjacent = useCallback(
    (direction: "next" | "previous") => {
      const targetId = getAdjacentOrderedId(orderedIds, activeId, direction);
      if (targetId !== null) activate(targetId);
    },
    [activate, activeId, orderedIds],
  );

  useAppHotkey("activateOpenTab", activateByPosition, {
    enabled: enabled && orderedIds.length > 0,
    isAvailable: ({ event, source }) => {
      if (source !== "keyboard" || event === null) return false;
      if (event.key.toLowerCase() === "g") return true;
      return getOrderedIdForShortcut(orderedIds, event.key) !== null;
    },
  });
  useAppHotkey("nextConversation", () => activateAdjacent("next"), {
    enabled: enabled && orderedIds.length > 1,
  });
  useAppHotkey("prevConversation", () => activateAdjacent("previous"), {
    enabled: enabled && orderedIds.length > 1,
  });
}
