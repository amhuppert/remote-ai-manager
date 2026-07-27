"use client";

import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";

export interface UseClearInputHotkeyArgs {
  editorRef: RefObject<PromptEditorHandle | null>;
  setPromptText: Dispatch<SetStateAction<string>>;
  clearPlaceholder: () => void;
  clearImages: () => void;
}

export function useClearInputHotkey({
  editorRef,
  setPromptText,
  clearPlaceholder,
  clearImages,
}: UseClearInputHotkeyArgs): void {
  const handleClear = useCallback(() => {
    if (!editorRef.current) return;
    editorRef.current.clear();
    setPromptText("");
    clearPlaceholder();
    clearImages();
  }, [editorRef, setPromptText, clearPlaceholder, clearImages]);
  useAppHotkey("clearInput", handleClear, {
    isAvailable: () => editorRef.current !== null,
  });
}
