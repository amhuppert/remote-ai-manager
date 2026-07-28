"use client";

import { useState } from "react";

export interface UseCodexFastModeInput {
  conversationId: string | null;
  promptCount: number;
  defaultValue: boolean;
  lastUsedValue?: boolean;
}

export interface UseCodexFastModeResult {
  codexFastMode: boolean;
  setCodexFastMode: (enabled: boolean) => void;
}

/**
 * Owns the conversation-local Codex speed selection. The global value is read
 * only when a conversation is initialized; sent turns then become the durable
 * source for that conversation.
 */
export function useCodexFastMode({
  conversationId,
  promptCount,
  defaultValue,
  lastUsedValue,
}: UseCodexFastModeInput): UseCodexFastModeResult {
  const [codexFastMode, setCodexFastMode] = useState(
    () => lastUsedValue ?? defaultValue,
  );
  const rememberedKey = JSON.stringify([
    conversationId,
    promptCount > 0 ? lastUsedValue : undefined,
  ]);
  const [previousConversationId, setPreviousConversationId] =
    useState(conversationId);
  const [previousRememberedKey, setPreviousRememberedKey] =
    useState(rememberedKey);

  if (rememberedKey !== previousRememberedKey) {
    const conversationChanged = conversationId !== previousConversationId;
    const provisionalConversationPromoted =
      previousConversationId === null && conversationId !== null;
    setPreviousConversationId(conversationId);
    setPreviousRememberedKey(rememberedKey);

    if (conversationChanged && !provisionalConversationPromoted) {
      setCodexFastMode(lastUsedValue ?? defaultValue);
    } else if (promptCount > 0 && lastUsedValue !== undefined) {
      setCodexFastMode(lastUsedValue);
    }
  }

  return { codexFastMode, setCodexFastMode };
}
