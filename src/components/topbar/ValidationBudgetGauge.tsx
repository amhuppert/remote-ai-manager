"use client";

import { cn } from "@/lib/ui/cn";
import type { ValidationBudgetView } from "@/lib/validation/budget-view";

/**
 * The ring gauge shared by the topbar trigger, the detail panel header, and
 * the mobile sheet. Two geometries only — a compact bar-sized ring and the
 * large panel ring — because a freely-scaled radius would put the stroke
 * weight out of proportion at the sizes in between.
 */

type GaugeSize = "compact" | "large";

const GEOMETRY: Record<
  GaugeSize,
  { viewBox: number; center: number; radius: number; strokeWidth: number }
> = {
  compact: { viewBox: 22, center: 11, radius: 8, strokeWidth: 3 },
  large: { viewBox: 52, center: 26, radius: 20, strokeWidth: 6 },
};

// Cyan reads "running"; amber is CC's awaiting tone and takes over the moment
// something is queued behind the budget. `--cc-ring-glow` feeds the shared
// ring-pulse keyframe so one animation serves both tones.
const TONE_STROKE: Record<ValidationBudgetView["tone"], string> = {
  active: "stroke-cyan",
  saturated: "stroke-amber",
};

const TONE_GLOW: Record<ValidationBudgetView["tone"], string> = {
  active: "[--cc-ring-glow:var(--color-cyan-glow-strong)]",
  saturated: "[--cc-ring-glow:var(--color-amber-glow)]",
};

export interface ValidationBudgetGaugeProps {
  fraction: number;
  tone: ValidationBudgetView["tone"];
  size: GaugeSize;
  /** Rendered width/height in px; the viewBox scales to it. */
  pixelSize: number;
}

export function ValidationBudgetGauge({
  fraction,
  tone,
  size,
  pixelSize,
}: ValidationBudgetGaugeProps): React.JSX.Element {
  const { viewBox, center, radius, strokeWidth } = GEOMETRY[size];
  const circumference = 2 * Math.PI * radius;

  return (
    <svg
      width={pixelSize}
      height={pixelSize}
      viewBox={`0 0 ${viewBox} ${viewBox}`}
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn(
        TONE_GLOW[tone],
        "motion-safe:animate-ring-pulse motion-reduce:animate-none",
      )}
    >
      <circle
        cx={center}
        cy={center}
        r={radius}
        className="stroke-border-dim"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={center}
        cy={center}
        r={radius}
        className={TONE_STROKE[tone]}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        // The arc length is the datum; a gap of one full circumference stops
        // the dash pattern from repeating around the track.
        strokeDasharray={`${fraction * circumference} ${circumference}`}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
}
