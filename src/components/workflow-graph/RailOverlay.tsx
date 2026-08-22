"use client";

import { cn } from "@/lib/ui/cn";

export type RailSide = "left" | "right";

/**
 * How an expanded rail sits over the canvas between 769px and 1100px, where
 * taking its full width out of the flow would leave the canvas unusable. It is
 * the same rail at the same width — only the stacking changes.
 */
export function railOverlayPanelClass(side: RailSide): string {
  return cn(
    "absolute inset-y-0 z-30 shadow-[var(--cc-shadow-popover)]",
    side === "left" ? "left-0" : "right-0",
  );
}

/**
 * The strip widths the two pages collapse to. Named rather than numeric because
 * Tailwind resolves arbitrary values at build time — a computed `w-[${n}px]`
 * would emit no rule at all.
 */
export type RailStripWidth = "36" | "48";

const STRIP_WIDTH_CLASS: Record<RailStripWidth, string> = {
  "36": "w-[36px] min-w-[36px]",
  "48": "w-[48px] min-w-[48px]",
};

/**
 * Holds the collapsed strip's width open underneath a floating rail so the
 * canvas does not shift when the rail is expanded. Carries no controls: the
 * rail floating above it already owns every one of them.
 *
 * `stripWidth` has no default: the whole point of the spacer is to be exactly
 * as wide as the strip it stands in for, and a default is how the two drift
 * apart without anything failing.
 */
export function RailOverlaySpacer({
  side,
  stripWidth,
}: {
  side: RailSide;
  stripWidth: RailStripWidth;
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-testid="rail-overlay-spacer"
      className={cn(
        "flex-shrink-0 border-y-0 border-solid border-border-subtle bg-bg-base",
        STRIP_WIDTH_CLASS[stripWidth],
        side === "left" ? "border-r border-l-0" : "border-r-0 border-l",
      )}
    />
  );
}
