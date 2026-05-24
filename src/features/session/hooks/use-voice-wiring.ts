"use client";

import { useCallback, useEffect, type MutableRefObject } from "react";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
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
}

export interface UseVoiceWiringResult {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;
  voiceAvailable: boolean;
  toggleRecording: () => void | Promise<void>;
}

export function useVoiceWiring({
  projectName,
  promptTextRef,
  editorRef,
  fireAndForgetRef,
  handleSendPrompt,
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
      void error;
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
      enabled: voiceAvailable && !isProcessing,
    },
  );

  useAppHotkey(
    "voiceFireAndForget",
    () => {
      if (!isRecording && !isProcessing) {
        fireAndForgetRef.current = true;
      }
      void toggleRecording();
    },
    {
      enabled: voiceAvailable && !isProcessing,
    },
  );

  return {
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
  };
}
