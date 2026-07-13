// @vitest-environment jsdom
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
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

import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useToastStoreForTesting } from "@/stores/toast.store";
import { useVoiceWiring } from "./use-voice-wiring";

describe("useVoiceWiring", () => {
  it("returns the voice state surface (isRecording, isProcessing, toggleRecording, stopAndSubmit)", () => {
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
    expect(typeof result.current.stopAndSubmit).toBe("function");
  });

  it("does not register a voiceFireAndForget hotkey (auto-submit is gestured via stopAndSubmit, not its own hotkey)", () => {
    vi.mocked(useAppHotkey).mockClear();
    renderHook(() => {
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
    const ids = vi.mocked(useAppHotkey).mock.calls.map(([id]) => id);
    expect(ids).not.toContain("voiceFireAndForget");
  });

  it("can suppress the global voice hotkey for locally scoped prompt surfaces", () => {
    vi.mocked(useAppHotkey).mockClear();
    vi.mocked(useVoiceRecorder).mockImplementation((() => ({
      isRecording: false,
      isProcessing: false,
      elapsedTime: 0,
      isAvailable: true,
      toggleRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
    })) as typeof useVoiceRecorder);

    renderHook(() => {
      const promptTextRef = useRef("");
      const editorRef = useRef(null);
      const fireAndForgetRef = useRef(false);
      return useVoiceWiring({
        projectName: "p",
        promptTextRef,
        editorRef,
        fireAndForgetRef,
        handleSendPrompt: async () => {},
        hotkeyEnabled: false,
      });
    });

    expect(vi.mocked(useAppHotkey)).toHaveBeenCalledWith(
      "voiceToggle",
      expect.any(Function),
      { enabled: false, keepActiveInOverlay: true },
    );
  });

  it("enables the voice hotkey only while its prompt editor has focus", () => {
    vi.mocked(useAppHotkey).mockClear();
    vi.mocked(useVoiceRecorder).mockImplementation((() => ({
      isRecording: false,
      isProcessing: false,
      elapsedTime: 0,
      isAvailable: true,
      toggleRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
    })) as typeof useVoiceRecorder);
    const editorElement = document.createElement("div");
    const input = document.createElement("textarea");
    editorElement.append(input);
    document.body.append(editorElement);

    try {
      renderHook(() => {
        const promptTextRef = useRef("");
        const editorRef = useRef({
          editor: { view: { dom: editorElement } },
          insertText: vi.fn(),
          focus: vi.fn(),
        });
        const fireAndForgetRef = useRef(false);
        return useVoiceWiring({
          projectName: "p",
          promptTextRef,
          editorRef: editorRef as never,
          fireAndForgetRef,
          handleSendPrompt: async () => {},
        });
      });

      expect(vi.mocked(useAppHotkey)).toHaveBeenLastCalledWith(
        "voiceToggle",
        expect.any(Function),
        { enabled: false, keepActiveInOverlay: true },
      );

      fireEvent.focusIn(input);

      expect(vi.mocked(useAppHotkey)).toHaveBeenLastCalledWith(
        "voiceToggle",
        expect.any(Function),
        { enabled: true, keepActiveInOverlay: true },
      );
    } finally {
      editorElement.remove();
    }
  });

  it("stopAndSubmit stops the recording and causes the voice result to be auto-submitted", async () => {
    let capturedOnResult: ((text: string) => void) | undefined;
    const toggleRecording = vi.fn();
    const stopRecording = vi.fn();

    vi.mocked(useVoiceRecorder).mockImplementation(((opts: {
      onResult: (text: string) => void;
    }) => {
      capturedOnResult = opts.onResult;
      return {
        isRecording: true,
        isProcessing: false,
        elapsedTime: 0,
        isAvailable: true,
        toggleRecording,
        stopRecording,
        cancelRecording: vi.fn(),
      };
    }) as typeof useVoiceRecorder);

    const handleSendPrompt = vi.fn(async () => {});

    const { result } = renderHook(() => {
      const promptTextRef = useRef("");
      const editorRef = useRef<{
        insertText: (s: string) => void;
        focus: () => void;
      } | null>({
        insertText: vi.fn(),
        focus: vi.fn(),
      });
      const fireAndForgetRef = useRef(false);
      return {
        wiring: useVoiceWiring({
          projectName: "p",
          promptTextRef,
          editorRef: editorRef as never,
          fireAndForgetRef,
          handleSendPrompt,
        }),
        fireAndForgetRef,
      };
    });

    await act(async () => {
      result.current.wiring.stopAndSubmit();
    });

    expect(stopRecording).toHaveBeenCalledTimes(1);
    expect(toggleRecording).not.toHaveBeenCalled();

    await act(async () => {
      capturedOnResult!("transcribed");
    });

    await waitFor(() => expect(handleSendPrompt).toHaveBeenCalledTimes(1));
  });

  it("surfaces a voice error as a toast so dropped recordings are not lost silently", async () => {
    useToastStoreForTesting.setState({ toasts: [] });

    let capturedOnError: ((error: string) => void) | undefined;
    vi.mocked(useVoiceRecorder).mockImplementation(((opts: {
      onError: (error: string) => void;
    }) => {
      capturedOnError = opts.onError;
      return {
        isRecording: false,
        isProcessing: false,
        elapsedTime: 0,
        isAvailable: true,
        toggleRecording: vi.fn(),
        stopRecording: vi.fn(),
        cancelRecording: vi.fn(),
      };
    }) as typeof useVoiceRecorder);

    renderHook(() => {
      const promptTextRef = useRef("");
      const editorRef = useRef(null);
      const fireAndForgetRef = useRef(true);
      return useVoiceWiring({
        projectName: "p",
        promptTextRef,
        editorRef,
        fireAndForgetRef,
        handleSendPrompt: async () => {},
      });
    });

    await act(async () => {
      capturedOnError!("No audio recorded");
    });

    const { toasts } = useToastStoreForTesting.getState();
    expect(toasts.map((t) => t.message)).toContain("No audio recorded");
  });

  it("stopAndSubmit is a no-op when not recording", () => {
    const toggleRecording = vi.fn();
    vi.mocked(useVoiceRecorder).mockImplementation((() => ({
      isRecording: false,
      isProcessing: false,
      elapsedTime: 0,
      isAvailable: true,
      toggleRecording,
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
    })) as typeof useVoiceRecorder);

    const handleSendPrompt = vi.fn(async () => {});

    const { result } = renderHook(() => {
      const promptTextRef = useRef("");
      const editorRef = useRef(null);
      const fireAndForgetRef = useRef(false);
      return {
        wiring: useVoiceWiring({
          projectName: "p",
          promptTextRef,
          editorRef,
          fireAndForgetRef,
          handleSendPrompt,
        }),
        fireAndForgetRef,
      };
    });

    act(() => {
      result.current.wiring.stopAndSubmit();
    });

    expect(toggleRecording).not.toHaveBeenCalled();
    expect(result.current.fireAndForgetRef.current).toBe(false);
  });
});
