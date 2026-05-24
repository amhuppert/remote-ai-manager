"use client";

import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";

export interface UseAbortOrClearHotkeyArgs {
  sending: boolean;
  conversationRunning: boolean;
  abortClient: () => void;
  abortPrompt: () => Promise<void>;
  editorRef: RefObject<PromptEditorHandle | null>;
  setPromptText: Dispatch<SetStateAction<string>>;
  clearPlaceholder: () => void;
  clearImages: () => void;
}

export function useAbortOrClearHotkey({
  sending,
  conversationRunning,
  abortClient,
  abortPrompt,
  editorRef,
  setPromptText,
  clearPlaceholder,
  clearImages,
}: UseAbortOrClearHotkeyArgs): void {
  const handleAbortOrClear = useCallback(() => {
    if (sending || conversationRunning) {
      if (sending) abortClient();
      void abortPrompt();
    } else {
      editorRef.current?.clear();
      setPromptText("");
      clearPlaceholder();
      clearImages();
    }
  }, [
    sending,
    conversationRunning,
    abortClient,
    abortPrompt,
    editorRef,
    setPromptText,
    clearPlaceholder,
    clearImages,
  ]);
  useAppHotkey("abortPrompt", handleAbortOrClear);
}
