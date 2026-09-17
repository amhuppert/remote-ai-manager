"use client";

import { createPortal } from "react-dom";
import { Button } from "@/components/ui/Button";
import { CLIP_AFFORDANCE_LABEL } from "./capture-affordance";
import {
  useTranscriptClipSelection,
  type TranscriptClipDraft,
} from "./use-transcript-clip-selection";

export interface TranscriptClipAffordanceProps {
  /** Receives the mapped selection when the user invokes Clip. */
  onClip(draft: TranscriptClipDraft): void;
  /** Surface root to scope to — see `useTranscriptClipSelection`. */
  within?: React.RefObject<HTMLElement | null>;
}

/**
 * The floating Clip trigger over transcript selections: owns the selection
 * hook, renders the trigger at the selection rect, and dismisses when the
 * selection ends or a press lands elsewhere. Mount once per transcript surface;
 * the landing wiring supplies `onClip`.
 */
export function TranscriptClipAffordance({
  onClip,
  within,
}: TranscriptClipAffordanceProps): React.JSX.Element | null {
  const { draft, clear } = useTranscriptClipSelection(within);

  if (draft === null) return null;

  /* Portal to <body>: the trigger is `position: fixed` against the viewport
     (snapped under the selection's viewport rect), but transcripts mount
     inside `.conversation-docked-stage`, whose transform would otherwise
     become its containing block and offset the trigger away from the selected
     text — the same trap the annotated-markdown trigger documents. */
  return createPortal(
    <span
      data-clip-affordance
      className="fixed z-popover [transform:translateX(-50%)]"
      style={{
        top: draft.rect.bottom + 6,
        left: draft.rect.left + draft.rect.width / 2,
      }}
    >
      <Button
        type="button"
        variant="default"
        size="touch"
        // Keep the selection alive: a default pointerdown would collapse it
        // before the click handler could read the draft.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          onClip(draft);
          clear();
        }}
      >
        <span aria-hidden="true" className="text-[0.85rem] leading-none">
          +
        </span>
        {CLIP_AFFORDANCE_LABEL}
      </Button>
    </span>,
    document.body,
  );
}
