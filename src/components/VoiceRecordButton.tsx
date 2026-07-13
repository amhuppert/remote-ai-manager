"use client";

import { cn } from "@/lib/ui/cn";

interface VoiceRecordButtonProps {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;
  isAvailable: boolean;
  toggleRecording: () => void;
  disabled?: boolean;
  unavailableReason?: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// `voice-btn` is retained purely as a hook for the prompt.css mobile override
// (`.prompt-toolbar .voice-btn { width/height: 44px }`), owned by the prompt
// slice; the button's own appearance is utilities. Hover is gated on
// data-recording=false so the recording state (red + pulse) wins while
// recording, matching the legacy source-order cascade.
const btnClass = cn(
  "voice-btn relative flex h-[36px] w-[36px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-solid border-border-default bg-transparent text-[1rem] text-text-secondary transition-all duration-150 ease-[ease]",
  "data-[recording=false]:hover:border-border-strong data-[recording=false]:hover:bg-bg-hover data-[recording=false]:hover:text-text-primary",
  "data-[recording=true]:animate-[voice-recording-pulse_1.5s_ease-in-out_infinite] data-[recording=true]:border-red data-[recording=true]:text-red",
  "disabled:cursor-not-allowed disabled:opacity-40",
);

export function VoiceRecordButton({
  isRecording,
  isProcessing,
  elapsedTime,
  isAvailable,
  toggleRecording,
  disabled = false,
  unavailableReason,
}: VoiceRecordButtonProps) {
  if (!isAvailable && !unavailableReason) return null;

  const isDisabled = disabled || isProcessing || !isAvailable;
  const accessibleLabel =
    unavailableReason && !isAvailable
      ? unavailableReason
      : isRecording
        ? "Stop recording"
        : isProcessing
          ? "Processing voice input"
          : "Voice input";

  return (
    <button
      type="button"
      className={btnClass}
      data-recording={isRecording}
      onClick={toggleRecording}
      disabled={isDisabled}
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      {isProcessing ? (
        <span className="spinner" aria-hidden="true" />
      ) : isRecording ? (
        <>
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="3"
              y="3"
              width="12"
              height="12"
              rx="2"
              fill="currentColor"
            />
          </svg>
          {elapsedTime > 0 && (
            <span
              className="absolute top-[-6px] right-[-6px] rounded-sm bg-red px-[4px] py-[2px] font-mono text-[0.7rem] leading-none whitespace-nowrap text-white"
              aria-hidden="true"
            >
              {formatTime(elapsedTime)}
            </span>
          )}
        </>
      ) : (
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="1" width="6" height="12" rx="3" />
          <path d="M5 10a7 7 0 0 0 14 0" />
          <line x1="12" y1="17" x2="12" y2="21" />
          <line x1="8" y1="21" x2="16" y2="21" />
        </svg>
      )}
    </button>
  );
}
