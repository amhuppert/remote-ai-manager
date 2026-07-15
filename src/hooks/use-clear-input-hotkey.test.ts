// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useRef } from "react";
import { useClearInputHotkey } from "./use-clear-input-hotkey";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";

vi.mock("@/hooks/useAppHotkey", () => ({
  useAppHotkey: vi.fn(),
}));

function lastRegisteredCallback(): (e: KeyboardEvent) => void {
  const calls = vi.mocked(useAppHotkey).mock.calls;
  const call = calls.findLast(([id]) => id === "clearInput");
  expect(call).toBeDefined();
  return call![1];
}

describe("useClearInputHotkey", () => {
  beforeEach(() => {
    vi.mocked(useAppHotkey).mockClear();
  });

  it("clears editor, text, placeholder, and images when prompt is focused", () => {
    const editorClear = vi.fn();
    const setPromptText = vi.fn();
    const clearPlaceholder = vi.fn();
    const clearImages = vi.fn();
    const isPromptFocused = vi.fn(() => true);

    renderHook(() => {
      const editorRef = useRef<PromptEditorHandle | null>({
        serialize: () => ({ prompt: "", images: [] }),
        clear: editorClear,
        focus: () => {},
        insertText: () => {},
        editor: null,
      });
      useClearInputHotkey({
        editorRef,
        setPromptText,
        clearPlaceholder,
        clearImages,
        isPromptFocused,
      });
    });

    lastRegisteredCallback()({} as KeyboardEvent);

    expect(editorClear).toHaveBeenCalledTimes(1);
    expect(setPromptText).toHaveBeenCalledWith("");
    expect(clearPlaceholder).toHaveBeenCalledTimes(1);
    expect(clearImages).toHaveBeenCalledTimes(1);
  });

  it("does nothing when prompt is not focused", () => {
    const editorClear = vi.fn();
    const setPromptText = vi.fn();
    const clearPlaceholder = vi.fn();
    const clearImages = vi.fn();
    const isPromptFocused = vi.fn(() => false);

    renderHook(() => {
      const editorRef = useRef<PromptEditorHandle | null>({
        serialize: () => ({ prompt: "", images: [] }),
        clear: editorClear,
        focus: () => {},
        insertText: () => {},
        editor: null,
      });
      useClearInputHotkey({
        editorRef,
        setPromptText,
        clearPlaceholder,
        clearImages,
        isPromptFocused,
      });
    });

    lastRegisteredCallback()({} as KeyboardEvent);

    expect(editorClear).not.toHaveBeenCalled();
    expect(setPromptText).not.toHaveBeenCalled();
    expect(clearPlaceholder).not.toHaveBeenCalled();
    expect(clearImages).not.toHaveBeenCalled();
  });
});
