"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { tracedFetch } from "@/lib/shared/traced-fetch";

interface UseVoiceRecorderOptions {
  projectName: string;
  maxDuration?: number;
  getContext?: () => string;
  onResult: (text: string) => void;
  onError: (error: string) => void;
}

interface UseVoiceRecorderReturn {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;
  isAvailable: boolean;
  toggleRecording: () => void;
  stopRecording: () => void;
}

type RecordingState = "idle" | "recording" | "processing";

const MIN_RECORDING_DURATION = 0.5;
const HEALTH_CHECK_INTERVAL = 30000;

function negotiateMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm"];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

export function useVoiceRecorder(
  options: UseVoiceRecorderOptions,
): UseVoiceRecorderReturn {
  const {
    projectName,
    maxDuration = 300,
    getContext,
    onResult,
    onError,
  } = options;

  const [state, setState] = useState<RecordingState>("idle");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isAvailable, setIsAvailable] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const maxDurationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const startTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stable callback refs
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const getContextRef = useRef(getContext);
  onResultRef.current = onResult;
  onErrorRef.current = onError;
  getContextRef.current = getContext;

  // Health check — only checks server availability; client capability
  // (navigator.mediaDevices) is validated at recording time so the button
  // stays visible on non-HTTPS mobile connections.
  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/voice/health");
      const data = (await response.json()) as { available: boolean };
      setIsAvailable(data.available);
    } catch {
      setIsAvailable(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    healthIntervalRef.current = setInterval(checkHealth, HEALTH_CHECK_INTERVAL);
    return () => {
      if (healthIntervalRef.current) {
        clearInterval(healthIntervalRef.current);
      }
    };
  }, [checkHealth]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
      if (timerRef.current) clearInterval(timerRef.current);
      if (maxDurationTimerRef.current)
        clearTimeout(maxDurationTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
    };
  }, []);

  const stopAndProcess = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;

    // Clear timers
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (maxDurationTimerRef.current) {
      clearTimeout(maxDurationTimerRef.current);
      maxDurationTimerRef.current = null;
    }

    // Check minimum duration
    const duration = (Date.now() - startTimeRef.current) / 1000;
    if (duration < MIN_RECORDING_DURATION) {
      recorder.stop();
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
      setState("idle");
      setElapsedTime(0);
      onErrorRef.current("Recording too short");
      return;
    }

    // Stop recorder and wait for data
    return new Promise<void>((resolve) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        // Stop media tracks
        if (streamRef.current) {
          for (const track of streamRef.current.getTracks()) {
            track.stop();
          }
          streamRef.current = null;
        }

        const chunks = chunksRef.current;
        chunksRef.current = [];

        if (chunks.length === 0) {
          setState("idle");
          setElapsedTime(0);
          onErrorRef.current("No audio recorded");
          resolve();
          return;
        }

        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });

        setState("processing");
        setElapsedTime(0);

        // Send to transcription API
        const controller = new AbortController();
        abortControllerRef.current = controller;

        const ext = mimeType.includes("webm") ? ".webm" : ".wav";
        const formData = new FormData();
        formData.set(
          "audio",
          new File([blob], `recording${ext}`, { type: mimeType }),
        );
        formData.set("projectName", projectName);

        const contextText = getContextRef.current?.();
        if (contextText && contextText.trim()) {
          formData.set("context", contextText);
        }

        try {
          const response = await tracedFetch(
            "/api/voice/transcribe",
            "voice-transcribe",
            {
              method: "POST",
              body: formData,
              signal: controller.signal,
            },
          );

          if (!response.ok) {
            const data = (await response.json().catch(() => null)) as {
              error?: string;
            } | null;
            onErrorRef.current(data?.error ?? "Transcription failed");
          } else {
            const data = (await response.json()) as { text: string };
            onResultRef.current(data.text);
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            // Aborted on unmount — ignore
          } else {
            const message =
              err instanceof Error ? err.message : "Transcription failed";
            onErrorRef.current(message);
          }
        } finally {
          abortControllerRef.current = null;
          setState("idle");
        }

        resolve();
      };

      recorder.stop();
    });
  }, [projectName]);

  const stopRecording = useCallback(() => {
    if (state === "recording") {
      void stopAndProcess();
    }
  }, [state, stopAndProcess]);

  const toggleRecording = useCallback(async () => {
    if (state === "processing") return;

    if (state === "recording") {
      await stopAndProcess();
      return;
    }

    // Start recording
    try {
      if (typeof navigator === "undefined" || !navigator.mediaDevices) {
        onErrorRef.current(
          "Voice recording requires a secure connection (HTTPS)",
        );
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = negotiateMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.start(1000); // Collect data every second
      startTimeRef.current = Date.now();
      setState("recording");
      setElapsedTime(0);

      // Elapsed time timer
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      // Max duration auto-stop
      maxDurationTimerRef.current = setTimeout(() => {
        stopAndProcess();
      }, maxDuration * 1000);
    } catch {
      onErrorRef.current("Microphone access denied");
    }
  }, [state, maxDuration, stopAndProcess]);

  return {
    isRecording: state === "recording",
    isProcessing: state === "processing",
    elapsedTime,
    isAvailable,
    toggleRecording,
    stopRecording,
  };
}
