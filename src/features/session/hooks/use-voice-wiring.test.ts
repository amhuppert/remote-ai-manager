// @vitest-environment jsdom
// Minimal smoke test for colocation criterion; deep behavior is covered by integration via SessionPage.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";

vi.mock(
  "@/hooks/useVoiceRecorder",
  async () => (await import("@/test/component-mocks")).voiceRecorderMock,
);
vi.mock(
  "@/hooks/useAppHotkey",
  async () => (await import("@/test/component-mocks")).appHotkeyMock,
);

import { useVoiceWiring } from "./use-voice-wiring";

describe("useVoiceWiring", () => {
  it("returns the voice state surface (isRecording, isProcessing, toggleRecording, etc.)", () => {
    const { result } = renderHook(() => {
      const promptTextRef = useRef("");
      const editorRef = useRef(null);
      const fireAndForgetRef = useRef(false);
      return useVoiceWiring({
        projectName: "p",
        promptTextRef,
        editorRef,
        fireAndForgetRef,
        handleSendPrompt: async () => {},
      });
    });
    expect(result.current.isRecording).toBe(false);
    expect(result.current.isProcessing).toBe(false);
    expect(result.current.elapsedTime).toBe(0);
    expect(result.current.voiceAvailable).toBe(false);
    expect(typeof result.current.toggleRecording).toBe("function");
  });
});
