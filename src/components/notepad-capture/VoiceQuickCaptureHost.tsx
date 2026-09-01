"use client";

import { useAppHotkey } from "@/hooks/useAppHotkey";

import { CaptureConfirmationToast } from "./CaptureConfirmationToast";
import { useVoiceQuickCapture } from "./use-voice-quick-capture";
import { VoiceQuickCapturePill } from "./VoiceQuickCapturePill";

/**
 * The root-layout host for voice quick capture, mounted beside the quick-ticket
 * host: both are app-global capture affordances that must work from whatever
 * route the user is on, and both read that route to decide which project they
 * belong to.
 *
 * The hotkey stays registered even while the voice service is down. Refusing to
 * register would make the key a silent no-op — the surface says so instead
 * (R25.4).
 */
export default function VoiceQuickCaptureHost(): React.JSX.Element | null {
  const capture = useVoiceQuickCapture();

  useAppHotkey("voiceQuickCapture", capture.toggle, {
    keepActiveInOverlay: true,
  });

  // A live capture outranks the previous one's confirmation: a recording whose
  // surface is hidden behind a toast has no destination, no elapsed time, and
  // no way to stop.
  if (capture.phase === "idle") {
    if (capture.confirmation === null) return null;
    return (
      <CaptureConfirmationToast
        notepadName={capture.confirmation.notepadName}
        preview={capture.confirmation.preview}
        onOpen={capture.openLanded}
        onUndo={capture.undoLanded}
        onDismiss={capture.dismissConfirmation}
      />
    );
  }

  return (
    <VoiceQuickCapturePill
      destinationName={capture.destinationName}
      elapsedTime={capture.elapsedTime}
      phase={capture.phase}
      onStop={capture.stop}
      onCancel={capture.cancel}
      onRetry={capture.retry}
      onDiscard={capture.discard}
    />
  );
}
