"use client";

import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import { useMultilineVoice } from "@/hooks/use-multiline-voice";
import {
  useStartRecording,
  useStopRecording,
} from "@/stores/session-detail.store";
import type { PromptEditorHandle } from "@/features/session/prompt/PromptEditor";
import type { ImageAttachment } from "@/hooks/use-image-attachments";

export interface UseVoiceWiringArgs {
  projectName: string;
  promptTextRef: MutableRefObject<string>;
  editorRef: MutableRefObject<PromptEditorHandle | null>;
  pendingImages?: ImageAttachment[];
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
  pendingImages = [],
  fireAndForgetRef,
  handleSendPrompt,
  hotkeyEnabled = true,
}: UseVoiceWiringArgs): UseVoiceWiringResult {
  const startRecording = useStartRecording();
  const stopRecording = useStopRecording();
  const [isEditorFocused, setIsEditorFocused] = useState(false);

  useEffect(() => {
    const isPromptEditorTarget = (target: EventTarget | null) => {
      const editorElement = editorRef.current?.editor?.view.dom;
      return target instanceof Node && editorElement?.contains(target);
    };
    const syncFocus = (target: EventTarget | null) => {
      setIsEditorFocused(isPromptEditorTarget(target) ?? false);
    };
    const handleFocusIn = (event: FocusEvent) => syncFocus(event.target);
    const handleFocusOut = () => {
      requestAnimationFrame(() => syncFocus(document.activeElement));
    };

    syncFocus(document.activeElement);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
    };
  }, [editorRef]);

  const voice = useMultilineVoice({
    projectName,
    valueRef: promptTextRef,
    getContext: () =>
      editorRef.current?.serialize(pendingImages).prompt ??
      promptTextRef.current,
    insertText: (text) => editorRef.current?.insertText(text),
    focus: () => editorRef.current?.focus(),
    isFocused: isEditorFocused,
    hotkeyEnabled,
    onStopAndSubmit: () => {
      fireAndForgetRef.current = false;
      void handleSendPrompt();
    },
    onError: () => {
      fireAndForgetRef.current = false;
    },
  });

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: voiceAvailable,
  } = voice;

  useEffect(() => {
    if (isRecording) startRecording();
    else stopRecording();
  }, [isRecording, startRecording, stopRecording]);

  const toggleRecording = useCallback(() => {
    if (!isRecording && !isProcessing) {
      fireAndForgetRef.current = false;
    }
    voice.toggleRecording();
  }, [fireAndForgetRef, isProcessing, isRecording, voice]);

  const stopAndSubmit = useCallback(() => {
    if (!isRecording && !isProcessing) return;
    fireAndForgetRef.current = true;
    voice.stopAndSubmit();
  }, [fireAndForgetRef, isProcessing, isRecording, voice]);

  return {
    isRecording,
    isProcessing,
    elapsedTime,
    voiceAvailable,
    toggleRecording,
    stopAndSubmit,
  };
}
