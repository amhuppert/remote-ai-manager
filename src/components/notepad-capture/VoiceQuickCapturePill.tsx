"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { formatVoiceElapsed } from "@/components/VoiceRecordButton";
import { cn } from "@/lib/ui/cn";

export interface VoiceQuickCapturePillProps {
  /** Null only while the destination is still being resolved. */
  destinationName: string | null;
  elapsedTime: number;
  phase: "preparing" | "recording" | "processing" | "failed" | "landing-failed";
  onStop(): void;
  onCancel(): void;
  onRetry(): void;
  onDiscard(): void;
}

const surfaceClass = cn(
  "fixed bottom-lg left-1/2 z-toast flex [transform:translateX(-50%)] items-center gap-sm rounded-full border border-solid border-red bg-bg-elevated px-md py-sm shadow-[0_8px_24px_var(--cc-black-a50)]",
  "focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2",
);

const actionClass =
  "inline-flex cursor-pointer items-center rounded-full border border-solid border-border-default bg-transparent px-sm py-[2px] font-mono text-[0.72rem] font-semibold text-text-secondary hover:border-border-strong hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

/**
 * The floating quick-capture surface: what the user is recording into, how long
 * they have been talking, and the two ways out.
 *
 * Portaled to document.body because the docked conversation stage carries a
 * transform, which makes it the containing block for every `position: fixed`
 * descendant and would displace this pill by roughly (340, 157) whenever the
 * hotkey fired from the right pane.
 *
 * A labelled region rather than a dialog: nothing here is modal — no scrim, no
 * focus trap, and the app stays usable while it records. It takes focus anyway
 * so Enter and Escape reach it as element keydowns — the hotkey registry owns
 * the app's keyboard actions, and a raw document-level listener for those two
 * keys would sit outside it — and hands focus back to wherever the user was
 * when the capture ends.
 *
 * Enter is always the surface's forward action (stop, then retry) and Escape
 * always the way out (cancel, then discard). A failed transcription is the one
 * state that stays put until the user picks one of them: the recording is still
 * in hand, and dismissing it on a timer would lose what they said (R25.4).
 */
export function VoiceQuickCapturePill({
  destinationName,
  elapsedTime,
  phase,
  onStop,
  onCancel,
  onRetry,
  onDiscard,
}: VoiceQuickCapturePillProps): React.JSX.Element | null {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const recording = phase === "recording";
  const preparing = phase === "preparing";
  // Both failures hold spoken words back, and both offer the same way out.
  const failed = phase === "failed" || phase === "landing-failed";

  useEffect(() => {
    const restoreTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    surfaceRef.current?.focus();
    return () => {
      restoreTo?.focus();
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <section
      ref={surfaceRef}
      aria-label="Voice quick capture"
      tabIndex={-1}
      className={surfaceClass}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          if (phase === "processing") return;
          event.preventDefault();
          if (failed) onRetry();
          else onStop();
          return;
        }
        if (event.key === "Escape") {
          if (phase === "processing") return;
          event.preventDefault();
          if (failed) onDiscard();
          else onCancel();
        }
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-[10px] shrink-0 rounded-full bg-red",
          recording &&
            "motion-safe:animate-[voice-recording-pulse_1.5s_ease-in-out_infinite]",
        )}
      />
      {/* The live region is this line alone: it announces each change of state,
          while the second-by-second timer beside it stays out of the region so
          it is not read aloud every tick. */}
      <p
        role="status"
        className="m-0 font-mono text-[0.74rem] text-text-primary"
      >
        {preparing && "Finding the notepad to capture into…"}
        {phase === "processing" && "Transcribing…"}
        {recording && `Recording to ${destinationName ?? ""}`}
        {/* Cause-agnostic on purpose: a recording is held back when the request
            failed, when the service returned no words, and when it was judged
            too short to send. The toast carries which of those happened; naming
            one of them here would be false for the other two. */}
        {phase === "failed" && "Not transcribed — your recording is still here"}
        {phase === "landing-failed" &&
          `Couldn't save to ${destinationName ?? "the notepad"} — your words are still here`}
      </p>
      {recording && (
        <span className="font-mono text-[0.72rem] text-text-secondary tabular-nums">
          {formatVoiceElapsed(elapsedTime)}
        </span>
      )}
      {recording && (
        <button type="button" className={actionClass} onClick={onStop}>
          Stop
        </button>
      )}
      {(recording || preparing) && (
        <button type="button" className={actionClass} onClick={onCancel}>
          Cancel
        </button>
      )}
      {failed && (
        <>
          <button type="button" className={actionClass} onClick={onRetry}>
            Retry
          </button>
          <button type="button" className={actionClass} onClick={onDiscard}>
            Discard
          </button>
        </>
      )}
    </section>,
    document.body,
  );
}
