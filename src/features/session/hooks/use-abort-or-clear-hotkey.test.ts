// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via SessionPage.
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { useAbortOrClearHotkey } from "./use-abort-or-clear-hotkey";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";

describe("useAbortOrClearHotkey", () => {
  it("registers without throwing when given valid args", () => {
    const { result } = renderHook(() => {
      const editorRef = useRef<PromptEditorHandle | null>(null);
      useAbortOrClearHotkey({
        sending: false,
        conversationRunning: false,
        abortClient: () => {},
        abortPrompt: async () => {},
        editorRef,
        setPromptText: () => {},
        clearPlaceholder: () => {},
        clearImages: () => {},
      });
      return true;
    });
    expect(result.current).toBe(true);
  });
});
