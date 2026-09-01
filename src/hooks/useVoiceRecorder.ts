"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { tracedFetch } from "@/lib/shared/traced-fetch";

export interface TranscriptionRequest {
  /**
   * The recorded audio. Held onto across a failed transcription so a retry
   * re-sends these exact bytes instead of asking the user to speak again.
   */
  audio: File;
  projectName?: string;
  context?: string;
  signal: AbortSignal;
}

/** Resolves to the transcribed text, or throws with a user-facing message. */
export type TranscribeAudio = (
  request: TranscriptionRequest,
) => Promise<string>;

interface UseVoiceRecorderOptions {
  /**
   * Omitted — or blank — for a consumer that belongs to no project, such as a
   * quick capture bound for a global notepad. The transcription request then
   * carries no project name at all; the route and the upstream contract both
   * treat it as optional.
   */
  projectName?: string;
  enabled?: boolean;
  maxDuration?: number;
  /**
   * The transcription context, read when the recording stops rather than when
   * it starts, so it reflects what the source says at the moment the audio is
   * sent. May be async: a caller that has to fetch it is not forced to hand
   * over a stale snapshot instead.
   */
  getContext?: () => string | Promise<string>;
  /**
   * The transcription boundary, injectable so a test can drive the failure and
   * retry paths over the very audio the recorder retained. Defaults to CC's own
   * transcribe route.
   */
  transcribe?: TranscribeAudio;
  onResult: (text: string) => void;
  onError: (error: string) => void;
}

interface UseVoiceRecorderReturn {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;
  isAvailable: boolean;
  /** A recording whose transcription failed and is still on hand to retry. */
  hasRetryableRecording: boolean;
  /**
   * Whether the voice service can be used, waiting for the first health answer
   * if it has not arrived. Callers that must decide at the moment of a user
   * action use this rather than `isAvailable`, which reads false while the
   * first probe is still in flight and would turn a healthy service into a
   * refusal.
   */
  ensureAvailable: () => Promise<boolean>;
  toggleRecording: () => void;
  stopRecording: () => void;
  cancelRecording: () => void;
  retryTranscription: () => void;
  discardRecording: () => void;
}

/** Health as actually known: unanswered is its own state, not a failure. */
type Availability = "unknown" | "available" | "unavailable";

/** A recording waiting on a transcription — its first, or a retry of it. */
interface PendingTranscription {
  audio: File;
  /** Read once, when the recording stopped: a retry sends the same context. */
  context?: string;
}

type RecordingState = "idle" | "recording" | "processing";

const MIN_RECORDING_DURATION = 0.5;
const HEALTH_CHECK_INTERVAL = 30000;

/** The production transcription call: CC's route, which proxies Voice2Text. */
async function postTranscription(
  request: TranscriptionRequest,
): Promise<string> {
  const formData = new FormData();
  formData.set("audio", request.audio);
  if (request.projectName) formData.set("projectName", request.projectName);
  if (request.context) formData.set("context", request.context);

  const response = await tracedFetch(
    "/api/voice/transcribe",
    "voice-transcribe",
    { method: "POST", body: formData, signal: request.signal },
  );

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error ?? "Transcription failed");
  }
  const data = (await response.json()) as { text: string };
  return data.text;
}

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
    transcribe,
    onResult,
    onError,
  } = options;

  const [state, setState] = useState<RecordingState>("idle");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [availability, setAvailability] = useState<Availability>("unknown");
  const [pendingRecording, setPendingRecording] =
    useState<PendingTranscription | null>(null);

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
  const availabilityRef = useRef<Availability>("unknown");
  availabilityRef.current = availability;
  /** The in-flight health probe, so concurrent askers share one request. */
  const healthProbeRef = useRef<Promise<boolean> | null>(null);
  /**
   * Read at transcription time rather than closed over: the max-duration timer
   * is armed when recording starts, and a capture whose project is settled
   * after that must still post under the right project.
   */
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;

  // Stable callback refs
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const getContextRef = useRef(getContext);
  const transcribeRef = useRef(transcribe);
  onResultRef.current = onResult;
  onErrorRef.current = onError;
  getContextRef.current = getContext;
  transcribeRef.current = transcribe;

  // Health check — only checks server availability; client capability
  // (navigator.mediaDevices) is validated at recording time so the button
  // stays visible on non-HTTPS mobile connections.
  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch("/api/voice/health");
      const data = (await response.json()) as { available: boolean };
      if (mountedRef.current && enabledRef.current) {
        setAvailability(data.available ? "available" : "unavailable");
      }
      return data.available;
    } catch {
      if (mountedRef.current && enabledRef.current) {
        setAvailability("unavailable");
      }
      return false;
    }
  }, []);

  /** One probe at a time; every caller awaiting health shares its answer. */
  const probeHealth = useCallback((): Promise<boolean> => {
    const inFlight = healthProbeRef.current;
    if (inFlight !== null) return inFlight;
    const probe = checkHealth();
    healthProbeRef.current = probe;
    void probe.finally(() => {
      healthProbeRef.current = null;
    });
    return probe;
  }, [checkHealth]);

  /**
   * The honest answer to "can I record right now", which is worth waiting for:
   * treating an unanswered probe as a refusal drops the user's first press on
   * a service that is perfectly healthy.
   */
  const ensureAvailable = useCallback(async (): Promise<boolean> => {
    if (!enabledRef.current) return false;
    if (availabilityRef.current !== "unknown") {
      return availabilityRef.current === "available";
    }
    return await probeHealth();
  }, [probeHealth]);

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
    // Cancelling is the explicit "throw it away" act, so it is the one path
    // that drops a retained recording along with the live one.
    setPendingRecording(null);
    if (mountedRef.current) {
      setState("idle");
      setElapsedTime(0);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setAvailability("unavailable");
      cancelRecording();
      return;
    }
    void probeHealth();
    healthIntervalRef.current = setInterval(() => {
      void probeHealth();
    }, HEALTH_CHECK_INTERVAL);
    return () => {
      if (healthIntervalRef.current) {
        clearInterval(healthIntervalRef.current);
      }
    };
  }, [cancelRecording, probeHealth, enabled]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRecording();
    };
  }, [cancelRecording]);

  /**
   * Send a recording for transcription. The recording stays retained until it
   * either transcribes or the user throws it away, so a voice server that is
   * down costs a retry rather than the words themselves (R25.4).
   */
  const runTranscription = useCallback(
    async (pending: PendingTranscription, generation: number) => {
      const isCurrent = () =>
        generation === generationRef.current &&
        enabledRef.current &&
        mountedRef.current;

      // Checked before anything is posted or shown: a capture cancelled on the
      // way here must not reach the network, and must not strand the surface
      // in a processing state nothing will ever finish.
      if (!isCurrent()) return;

      const controller = new AbortController();
      abortControllerRef.current = controller;
      if (mountedRef.current) {
        setState("processing");
        setElapsedTime(0);
      }

      try {
        const projectName = projectNameRef.current;
        const text = await (transcribeRef.current ?? postTranscription)({
          audio: pending.audio,
          ...(projectName ? { projectName } : {}),
          ...(pending.context ? { context: pending.context } : {}),
          signal: controller.signal,
        });
        if (!isCurrent()) return;
        // A 200 carrying no words is not a success: the user spoke, so the
        // audio stays on hand for a retry rather than being thrown away on
        // the service's say-so (R25.4).
        if (text.trim().length === 0) {
          onErrorRef.current(
            "Nothing was transcribed — your recording is still here",
          );
          return;
        }
        setPendingRecording(null);
        onResultRef.current(text);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Aborted on unmount or cancel — the recording went with it.
          return;
        }
        const message =
          err instanceof Error ? err.message : "Transcription failed";
        if (isCurrent()) onErrorRef.current(message);
      } finally {
        abortControllerRef.current = null;
        if (generation === generationRef.current && mountedRef.current) {
          setState("idle");
        }
      }
    },
    [],
  );

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

    /**
     * Too brief to be worth sending unprompted — but the bytes are still
     * something the user said. Half a second is an arbitrary line that a
     * deliberate short word falls the wrong side of, so a too-short recording
     * is held for Retry or Discard rather than binned (R25.4).
     */
    const tooShort =
      (Date.now() - startTimeRef.current) / 1000 < MIN_RECORDING_DURATION;

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
        const ext = mimeType.includes("webm") ? ".webm" : ".wav";
        const contextText = await getContextRef.current?.();
        // Reading context can take a moment, and a cancel landing inside that
        // window has to win: without this the audio would be posted for a
        // capture the user already threw away.
        if (generation !== generationRef.current || !enabledRef.current) {
          resolve();
          return;
        }
        const pending: PendingTranscription = {
          audio: new File([blob], `recording${ext}`, { type: mimeType }),
          ...(contextText && contextText.trim()
            ? { context: contextText }
            : {}),
        };
        setPendingRecording(pending);

        if (tooShort) {
          if (mountedRef.current) {
            setState("idle");
            setElapsedTime(0);
          }
          onErrorRef.current("Recording too short");
          resolve();
          return;
        }

        await runTranscription(pending, generation);

        resolve();
      };

      recorder.stop();
    });
  }, [runTranscription]);

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

  const retryTranscription = useCallback(() => {
    if (pendingRecording === null || state !== "idle") return;
    void runTranscription(pendingRecording, generationRef.current);
  }, [pendingRecording, runTranscription, state]);

  const discardRecording = useCallback(() => setPendingRecording(null), []);

  return {
    isRecording: state === "recording",
    isProcessing: state === "processing",
    elapsedTime,
    isAvailable: availability === "available",
    hasRetryableRecording: pendingRecording !== null,
    ensureAvailable,
    toggleRecording,
    stopRecording,
    cancelRecording,
    retryTranscription,
    discardRecording,
  };
}
