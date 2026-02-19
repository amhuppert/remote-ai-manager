"use client";

interface VoiceRecordButtonProps {
  isRecording: boolean;
  isProcessing: boolean;
  elapsedTime: number;
  isAvailable: boolean;
  toggleRecording: () => void;
  disabled?: boolean;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VoiceRecordButton({
  isRecording,
  isProcessing,
  elapsedTime,
  isAvailable,
  toggleRecording,
  disabled = false,
}: VoiceRecordButtonProps) {
  if (!isAvailable) return null;

  const isDisabled = disabled || isProcessing;

  return (
    <button
      type="button"
      className={`voice-btn${isRecording ? " voice-recording" : ""}`}
      onClick={toggleRecording}
      disabled={isDisabled}
      title={
        isRecording
          ? "Stop recording"
          : isProcessing
            ? "Processing..."
            : "Voice input"
      }
    >
      {isProcessing ? (
        <span className="spinner" />
      ) : isRecording ? (
        <>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
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
            <span className="voice-timer">{formatTime(elapsedTime)}</span>
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
