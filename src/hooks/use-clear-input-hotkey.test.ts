// @vitest-environment jsdom
import { createElement, type PropsWithChildren, type RefObject } from "react";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  HotkeyProvider,
  type HotkeyProviderProps,
} from "@/components/hotkeys/HotkeyProvider";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
import { useClearInputHotkey } from "./use-clear-input-hotkey";

function editorHandle(clear: () => void): PromptEditorHandle {
  return {
    serialize: () => ({ prompt: "", images: [] }),
    clear,
    focus: () => {},
    insertText: () => {},
    editor: null,
  };
}

describe("useClearInputHotkey", () => {
  it("clears the active editor after the launcher takes focus", () => {
    const dispatcher = createHotkeyDispatcher();
    const editorClear = vi.fn();
    const setPromptText = vi.fn();
    const clearPlaceholder = vi.fn();
    const clearImages = vi.fn();
    const editorRef: RefObject<PromptEditorHandle | null> = {
      current: editorHandle(editorClear),
    };

    renderHook(
      () =>
        useClearInputHotkey({
          editorRef,
          setPromptText,
          clearPlaceholder,
          clearImages,
        }),
      {
        wrapper: ({ children }: PropsWithChildren) =>
          createElement(
            HotkeyProvider,
            { dispatcher } as HotkeyProviderProps,
            children,
          ),
      },
    );

    expect(dispatcher.invoke("clearInput")).toBe(true);
    expect(editorClear).toHaveBeenCalledOnce();
    expect(setPromptText).toHaveBeenCalledWith("");
    expect(clearPlaceholder).toHaveBeenCalledOnce();
    expect(clearImages).toHaveBeenCalledOnce();
  });

  it("is available only while an active prompt editor is mounted", () => {
    const dispatcher = createHotkeyDispatcher();
    const editorRef: RefObject<PromptEditorHandle | null> = {
      current: editorHandle(vi.fn()),
    };

    renderHook(
      () =>
        useClearInputHotkey({
          editorRef,
          setPromptText: vi.fn(),
          clearPlaceholder: vi.fn(),
          clearImages: vi.fn(),
        }),
      {
        wrapper: ({ children }: PropsWithChildren) =>
          createElement(
            HotkeyProvider,
            { dispatcher } as HotkeyProviderProps,
            children,
          ),
      },
    );

    const availability = () =>
      dispatcher
        .getCommands()
        .find(({ definition }) => definition.id === "clearInput")?.available;

    expect(availability()).toBe(true);
    editorRef.current = null;
    expect(availability()).toBe(false);
  });
});
