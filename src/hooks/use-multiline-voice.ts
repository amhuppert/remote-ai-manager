"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type MutableRefObject,
} from "react";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { pushToast } from "@/stores/toast.store";

export interface VoiceOwner {
  id: string;
  stop(): void;
}

export interface VoiceOwnership {
  claim(owner: VoiceOwner): boolean;
  release(ownerId: string): void;
  currentId(): string | null;
}

export function createVoiceOwnership(): VoiceOwnership {
  let activeOwner: VoiceOwner | null = null;
  return {
    claim(owner) {
      if (activeOwner) {
        if (activeOwner.id !== owner.id) activeOwner.stop();
        return false;
      }
      activeOwner = owner;
      return true;
    },
    release(ownerId) {
      if (activeOwner?.id === ownerId) activeOwner = null;
    },
    currentId: () => activeOwner?.id ?? null,
  };
}

const voiceOwnership = createVoiceOwnership();

export interface UseMultilineVoiceArgs<TResult = void> {
  projectName?: string;
  valueRef: MutableRefObject<string>;
  getContext?(): string;
  insertText(text: string): TResult;
  focus(): void;
  isFocused: boolean;
  onStopAndSubmit?(result: TResult): void;
  onError?(): void;
  hotkeyEnabled?: boolean;
}

export interface MultilineVoiceState {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;
  isAvailable: boolean;
  toggleRecording(): void;
  stopAndSubmit(): void;
}

export function useMultilineVoice<TResult = void>({
  projectName,
  valueRef,
  getContext,
  insertText,
  focus,
  isFocused,
  onStopAndSubmit,
  onError,
  hotkeyEnabled = true,
}: UseMultilineVoiceArgs<TResult>): MultilineVoiceState {
  const ownerId = useId();
  const submitAfterResultRef = useRef(false);
  const postResultFrameRef = useRef<number | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const onStopAndSubmitRef = useRef(onStopAndSubmit);
  useEffect(() => {
    onStopAndSubmitRef.current = onStopAndSubmit;
  }, [onStopAndSubmit]);
  const enabled = Boolean(projectName);

  const handleResult = useCallback(
    (text: string) => {
      const prefix = valueRef.current.trim() ? "\n" : "";
      const result = insertText(`${prefix}${text}`);
      const shouldSubmit = submitAfterResultRef.current;
      submitAfterResultRef.current = false;
      const generation = lifecycleGenerationRef.current;
      postResultFrameRef.current = requestAnimationFrame(() => {
        postResultFrameRef.current = null;
        if (generation !== lifecycleGenerationRef.current) return;
        focus();
        if (shouldSubmit) onStopAndSubmitRef.current?.(result);
      });
    },
    [focus, insertText, valueRef],
  );

  const handleError = useCallback(
    (error: string) => {
      // Surface the failure: a dictation that fails (e.g. "No audio recorded",
      // a too-short clip, or a voice-server error) must never be lost silently —
      // swallowing it here was why dropped recordings looked like nothing
      // happened at all.
      submitAfterResultRef.current = false;
      voiceOwnership.release(ownerId);
      pushToast(error);
      onError?.();
    },
    [onError, ownerId],
  );

  const {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable,
    toggleRecording: toggleRecorder,
    stopRecording,
    cancelRecording,
  } = useVoiceRecorder({
    projectName: projectName ?? "",
    enabled,
    getContext: getContext ?? (() => valueRef.current),
    onResult: handleResult,
    onError: handleError,
  });
  const cancelVoice = useCallback(() => {
    lifecycleGenerationRef.current += 1;
    submitAfterResultRef.current = false;
    if (postResultFrameRef.current !== null) {
      cancelAnimationFrame(postResultFrameRef.current);
      postResultFrameRef.current = null;
    }
    cancelRecording();
    voiceOwnership.release(ownerId);
  }, [cancelRecording, ownerId]);

  useEffect(() => {
    if (!isRecording) {
      voiceOwnership.release(ownerId);
      return;
    }
    if (voiceOwnership.currentId() === ownerId) return;
    voiceOwnership.claim({ id: ownerId, stop: cancelVoice });
  }, [cancelVoice, isRecording, ownerId]);

  useEffect(
    () => () => {
      cancelVoice();
    },
    [cancelVoice],
  );

  const toggleRecording = useCallback(() => {
    if (!enabled) return;
    if (!isRecording) {
      const claimed = voiceOwnership.claim({
        id: ownerId,
        stop: cancelVoice,
      });
      if (!claimed) return;
    }
    void toggleRecorder();
  }, [cancelVoice, enabled, isRecording, ownerId, toggleRecorder]);

  useEffect(() => {
    if (hotkeyEnabled && enabled) return;
    cancelVoice();
  }, [cancelVoice, enabled, hotkeyEnabled]);

  const stopAndSubmit = useCallback(() => {
    if (!isRecording && !isProcessing) return;
    submitAfterResultRef.current = true;
    if (isRecording) stopRecording();
  }, [isProcessing, isRecording, stopRecording]);

  useAppHotkey("voiceToggle", () => toggleRecording(), {
    enabled:
      hotkeyEnabled && enabled && isFocused && isAvailable && !isProcessing,
    keepActiveInOverlay: true,
  });

  return {
    isRecording,
    isProcessing,
    elapsedTime,
    isAvailable: enabled && isAvailable,
    toggleRecording,
    stopAndSubmit,
  };
}
