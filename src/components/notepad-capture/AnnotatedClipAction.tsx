"use client";

import { Button } from "@/components/ui/Button";
import type { ClipFragmentInput } from "@/lib/notepads/capture-fragment";

import { CLIP_AFFORDANCE_LABEL } from "./capture-affordance";
import { useClipLanding } from "./use-clip-landing";

export interface AnnotatedClipActionProps {
  /** The project whose notepads the capture destination resolves over (D21). */
  projectName: string;
  /**
   * The current selection already described as a clip by the host's capability.
   * The annotated surface builds it — the action only lands it, so the fragment
   * shape stays the foundation builder's alone.
   */
  clip: ClipFragmentInput;
  /** Dismiss the affordance once the clip is on its way. */
  onClipped(): void;
}

/**
 * The Clip half of the annotated hosts' selection pill: it carries the
 * foundation landing pipeline (destination rule, fragment builder, append) into
 * the annotation seam, so all three hosts land identically and none of them
 * reimplements landing. Mounted only where a host opted into clip, which keeps
 * the landing hooks off every comment-only surface.
 */
export function AnnotatedClipAction({
  projectName,
  clip,
  onClipped,
}: AnnotatedClipActionProps): React.JSX.Element {
  const { land } = useClipLanding(projectName);

  return (
    <Button
      type="button"
      variant="default"
      size="touch"
      // Keep the selection alive: a default pointerdown would collapse it
      // before the click handler runs.
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        void land(clip);
        onClipped();
      }}
    >
      <span aria-hidden="true" className="text-[0.85rem] leading-none">
        +
      </span>
      {CLIP_AFFORDANCE_LABEL}
    </Button>
  );
}
