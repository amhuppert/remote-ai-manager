"use client";

import { useCallback, useEffect, type MutableRefObject } from "react";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { pushToast } from "@/stores/toast.store";
import {
  useStartRecording,
  useStopRecording,
} from "@/stores/session-detail.store";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";

export interface UseVoiceWiringArgs {
  projectName: string;
  promptTextRef: MutableRefObject<string>;
  editorRef: MutableRefObject<PromptEditorHandle | null>;
  fireAndForgetRef: MutableRefObject<boolean>;
  handleSendPrompt: () => Promise<void>;
  hotkeyEnabled?: boolean;
}

export interface UseVoiceWiringResult {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;
  voiceAvailable: boolean;
  toggleRecording: () => void | Promise<void>;
  /**
   * Stops an in-progress recording and arranges for the transcribed text to be
   * auto-submitted once it arrives. No-op when not currently recording.
   */
  stopAndSubmit: () => void;
}

export function useVoiceWiring({
  projectName,
  promptTextRef,
  editorRef,
  fireAndForgetRef,
  handleSendPrompt,
  hotkeyEnabled = true,
}: UseVoiceWiringArgs): UseVoiceWiringResult {
  const startRecording = useStartRecording();
  const stopRecording = useStopRecording();

  const handleVoiceResult = useCallback(
    (text: string) => {
      const insertion = promptTextRef.current.trim() ? `\n${text}` : text;
      editorRef.current?.insertText(insertion);
      requestAnimationFrame(() => editorRef.current?.focus());

      if (fireAndForgetRef.current) {
        fireAndForgetRef.current = false;
        void handleSendPrompt();
      }
    },
    [handleSendPrompt, editorRef, fireAndForgetRef, promptTextRef],
  );

  const handleVoiceError = useCallback(
    (error: string) => {
      // Surface the failure: a dictation that fails (e.g. "No audio recorded",
      // a too-short clip, or a voice-server error) must never be lost silently —
      // swallowing it here was why dropped recordings looked like nothing
      // happened at all.
      pushToast(error);
      fireAndForgetRef.current = false;
    },
    [fireAndForgetRef],
  );

  const getContext = useCallback(() => promptTextRef.current, [promptTextRef]);

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: voiceAvailable,
    toggleRecording,
  } = useVoiceRecorder({
    projectName,
    getContext,
    onResult: handleVoiceResult,
    onError: handleVoiceError,
  });

  useEffect(() => {
    if (isRecording) startRecording();
    else stopRecording();
  }, [isRecording, startRecording, stopRecording]);

  useAppHotkey(
    "voiceToggle",
    () => {
      if (!isRecording && !isProcessing) {
        fireAndForgetRef.current = false;
      }
      void toggleRecording();
    },
    {
      enabled: hotkeyEnabled && voiceAvailable && !isProcessing,
    },
  );

  const stopAndSubmit = useCallback(() => {
    if (!isRecording) return;
    fireAndForgetRef.current = true;
    void toggleRecording();
  }, [isRecording, toggleRecording, fireAndForgetRef]);

  return {
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
    stopAndSubmit,
  };
}
