"use client";

import { ViewportPortal } from "@xyflow/react";

import { AlertTriangleIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";

/**
 * What a cross-lane drag draws while it is in flight (design bundle B2): the
 * drop preview above the dragged card, and the ghost outline it left behind.
 *
 * Everything here is inert — no control, no focus stop — because a drag is a
 * pointer gesture and the keyboard route to the same edit is the Placement
 * screen's lane field, not this layer.
 */

export interface LaneDropGhost {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The lane the card is being dragged out of. */
  readonly laneName: string;
}

export interface LaneDropPreview {
  readonly x: number;
  readonly y: number;
  /** The B2 pill copy: `Re-place → lane: … · grade: … · unchanged`. */
  readonly label: string;
  readonly accepted: boolean;
}

export interface LaneDropOverlayProps {
  readonly ghost: LaneDropGhost;
  readonly preview: LaneDropPreview;
}

/** How far above the dragged card the preview pill floats, in flow units. */
const PREVIEW_OFFSET_Y = 34;

export default function LaneDropOverlay({
  ghost,
  preview,
}: LaneDropOverlayProps): React.JSX.Element {
  return (
    <ViewportPortal>
      <div
        aria-hidden="true"
        data-testid="lane-drop-overlay"
        className="pointer-events-none absolute top-0 left-0 font-mono"
      >
        <div
          data-testid="lane-drop-ghost"
          className="absolute flex items-center justify-center rounded-[10px] border border-dashed border-border-strong text-[0.7rem] font-medium text-text-tertiary opacity-55"
          style={{
            left: ghost.x,
            top: ghost.y,
            width: ghost.width,
            height: ghost.height,
          }}
        >
          was: lane {ghost.laneName}
        </div>
        <div
          data-testid="lane-drop-preview"
          data-accepted={preview.accepted ? "true" : "false"}
          className={cn(
            "absolute inline-flex items-center gap-sm rounded-md border border-solid bg-bg-elevated px-[11px] py-[5px] text-[0.72rem] font-medium whitespace-nowrap shadow-[0_8px_24px_var(--cc-black-a50)]",
            preview.accepted
              ? "border-[var(--cyan-glow-strong)] text-cyan"
              : "border-[var(--cc-red-a25)] text-red",
          )}
          style={{ left: preview.x, top: preview.y - PREVIEW_OFFSET_Y }}
        >
          {!preview.accepted && (
            <>
              <AlertTriangleIcon size={12} />
              <span className="font-semibold">Drop refused ·</span>
            </>
          )}
          {/*
            The pending change is spelled in full whether or not it will be
            allowed: an author needs to read what the drop WOULD do to
            understand why it cannot, and a bare "Drop refused" leaves the
            target lane and the carried grade unsaid at the one moment they
            are the question.
          */}
          <span
            className={preview.accepted ? undefined : "text-text-secondary"}
          >
            {preview.label}
          </span>
        </div>
      </div>
    </ViewportPortal>
  );
}
