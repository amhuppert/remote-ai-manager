"use client";

import { AlertTriangleIcon, CloseIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";

/**
 * What the canvas says after a lane drop (design bundle B2).
 *
 * Two tones, one card: a RED refusal — the placement check failed, the draft
 * was not touched — and an AMBER notice, for a placement that was accepted and
 * still costs something the author should know about (README §4: a full member
 * needs its lane to itself). Both are announced, because a pointer gesture that
 * quietly did nothing is the failure mode this card exists to prevent.
 */

export type LaneDropCalloutTone = "red" | "amber";

export interface LaneDropCalloutProps {
  readonly tone: LaneDropCalloutTone;
  readonly title: string;
  readonly message: string;
  /** The consequence line, e.g. that nothing was written. */
  readonly footnote?: string | null;
  readonly onDismiss: () => void;
}

// The tone tint is translucent, which reads over the canvas's own backdrop but
// not over the stacked cards of the mobile Graph panel — hence the blur.
const CARD_TONE: Record<LaneDropCalloutTone, string> = {
  red: "border-[var(--cc-red-a25)] bg-[var(--cc-red-a10)] [backdrop-filter:blur(12px)]",
  amber:
    "border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] [backdrop-filter:blur(12px)]",
};

const TITLE_TONE: Record<LaneDropCalloutTone, string> = {
  red: "text-red",
  amber: "text-amber",
};

export default function LaneDropCallout({
  tone,
  title,
  message,
  footnote,
  onDismiss,
}: LaneDropCalloutProps): React.JSX.Element {
  return (
    <div
      role={tone === "red" ? "alert" : "status"}
      data-testid="lane-drop-callout"
      data-tone={tone}
      className={cn(
        // Below 768px the card spans the panel and clears the floating graph
        // cluster, which parks itself in the same corner (README §12).
        "absolute right-md bottom-md z-20 flex w-[300px] flex-col gap-xs rounded-md border border-solid px-[11px] py-[9px] font-mono max-768:bottom-[68px] max-768:left-md max-768:w-auto",
        CARD_TONE[tone],
      )}
    >
      <div className="flex items-start gap-xs">
        <AlertTriangleIcon
          size={12}
          className={cn("mt-[2px] shrink-0", TITLE_TONE[tone])}
        />
        <span
          className={cn(
            "flex-1 text-[0.7rem] font-semibold tracking-[0.06em] uppercase",
            TITLE_TONE[tone],
          )}
        >
          {title}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss — ${title}`}
          className="inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-text-tertiary transition-colors duration-150 hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] max-768:size-[44px]"
        >
          <CloseIcon size={11} />
        </button>
      </div>
      <p className="m-0 text-[0.7rem] leading-[1.55] font-normal text-text-secondary">
        {message}
      </p>
      {footnote && (
        <p className="m-0 text-[0.7rem] leading-[1.55] font-normal text-text-tertiary">
          {footnote}
        </p>
      )}
    </div>
  );
}
