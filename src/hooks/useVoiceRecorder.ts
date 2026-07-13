"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { tracedFetch } from "@/lib/shared/traced-fetch";

interface UseVoiceRecorderOptions {
  projectName: string;
  enabled?: boolean;
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
  cancelRecording: () => void;
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
    enabled = true,
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
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

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
      if (mountedRef.current && enabledRef.current) {
        setIsAvailable(data.available);
      }
    } catch {
      if (mountedRef.current && enabledRef.current) setIsAvailable(false);
    }
  }, []);

  const cancelRecording = useCallback(() => {
    generationRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    if (maxDurationTimerRef.current) clearTimeout(maxDurationTimerRef.current);
    timerRef.current = null;
    maxDurationTimerRef.current = null;

    const recorder = mediaRecorderRef.current;
    if (recorder?.state === "recording") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (mountedRef.current) {
      setState("idle");
      setElapsedTime(0);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setIsAvailable(false);
      cancelRecording();
      return;
    }
    checkHealth();
    healthIntervalRef.current = setInterval(checkHealth, HEALTH_CHECK_INTERVAL);
    return () => {
      if (healthIntervalRef.current) {
        clearInterval(healthIntervalRef.current);
      }
    };
  }, [cancelRecording, checkHealth, enabled]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRecording();
    };
  }, [cancelRecording]);

  const stopAndProcess = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    const generation = generationRef.current;

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

        if (generation !== generationRef.current || !enabledRef.current) {
          chunksRef.current = [];
          resolve();
          return;
        }

        const chunks = chunksRef.current;
        chunksRef.current = [];

        if (chunks.length === 0) {
          if (mountedRef.current) {
            setState("idle");
            setElapsedTime(0);
          }
          onErrorRef.current("No audio recorded");
          resolve();
          return;
        }

        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });

        if (mountedRef.current) {
          setState("processing");
          setElapsedTime(0);
        }

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
            if (
              generation === generationRef.current &&
              enabledRef.current &&
              mountedRef.current
            ) {
              onErrorRef.current(data?.error ?? "Transcription failed");
            }
          } else {
            const data = (await response.json()) as { text: string };
            if (
              generation === generationRef.current &&
              enabledRef.current &&
              mountedRef.current
            ) {
              onResultRef.current(data.text);
            }
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            // Aborted on unmount — ignore
          } else {
            const message =
              err instanceof Error ? err.message : "Transcription failed";
            if (
              generation === generationRef.current &&
              enabledRef.current &&
              mountedRef.current
            ) {
              onErrorRef.current(message);
            }
          }
        } finally {
          abortControllerRef.current = null;
          if (generation === generationRef.current && mountedRef.current) {
            setState("idle");
          }
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
    if (!enabled) return;
    if (state === "processing") return;

    if (state === "recording") {
      await stopAndProcess();
      return;
    }

    // Start recording
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    try {
      if (typeof navigator === "undefined" || !navigator.mediaDevices) {
        onErrorRef.current(
          "Voice recording requires a secure connection (HTTPS)",
        );
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (
        generation !== generationRef.current ||
        !enabledRef.current ||
        !mountedRef.current
      ) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
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

      // Record into a single blob flushed on stop(). A timeslice (e.g.
      // start(1000)) makes the final partial segment depend on a stop()-time
      // flush that intermittently arrives empty for short clips, which dropped
      // the whole recording. Without a timeslice the entire recording is
      // delivered as one chunk when we stop.
      recorder.start();
      startTimeRef.current = Date.now();
      if (mountedRef.current) {
        setState("recording");
        setElapsedTime(0);
      }

      // Elapsed time timer
      timerRef.current = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      // Max duration auto-stop
      maxDurationTimerRef.current = setTimeout(() => {
        stopAndProcess();
      }, maxDuration * 1000);
    } catch {
      if (
        generation === generationRef.current &&
        enabledRef.current &&
        mountedRef.current
      ) {
        onErrorRef.current("Microphone access denied");
      }
    }
  }, [enabled, state, maxDuration, stopAndProcess]);

  return {
    isRecording: state === "recording",
    isProcessing: state === "processing",
    elapsedTime,
    isAvailable,
    toggleRecording,
    stopRecording,
    cancelRecording,
  };
}
