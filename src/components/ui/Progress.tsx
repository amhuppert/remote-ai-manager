"use client";

import { Progress as RadixProgress } from "radix-ui";
import { cn } from "@/lib/ui/cn";

// Radix-backed progress indicator. There is no interactive WAI-ARIA APG widget
// pattern for progress; it is the ARIA `progressbar` role
// (https://www.w3.org/WAI/ARIA/apg/patterns/ — `aria-valuenow`/`-valuemin`/
// `-valuemax`). Radix owns the semantics (role=progressbar, data-state
// loading/complete/indeterminate, data-value/data-max, and the aria-value*
// wiring — `value={null}` yields a true indeterminate state with no false
// `aria-valuenow`); these wrappers own CC appearance via the tone map + data-*
// variants. Not interactive (that is a Slider) and not a spinner.

type Tone = "accent" | "warning" | "danger";

// Borderless thin track on the inset surface — the canonical CC determinate bar
// (matches ContextFillIndicator's geometry). Per-consumer sizing (fixed width,
// flex-basis, responsive collapse) rides in on `layoutClassName`.
const trackClass =
  "relative h-[4px] w-full overflow-hidden rounded-[2px] bg-bg-base";

// Fill: width is driven by `value` (inline style); indeterminate fills the track
// and pulses. Transition mirrors the legacy context-fill bar.
const indicatorBase =
  "h-full rounded-[2px] [transition:width_0.4s_ease,background_0.3s_ease,box-shadow_0.3s_ease] data-[state=indeterminate]:w-full data-[state=indeterminate]:motion-safe:animate-pulse-dot";

const indicatorTone: Record<Tone, string> = {
  accent: "bg-cyan [box-shadow:0_0_6px_var(--cyan-glow-strong)]",
  warning: "bg-amber [box-shadow:0_0_6px_var(--amber-glow)]",
  danger: "bg-red [box-shadow:0_0_6px_var(--red-glow)]",
};

type ProgressProps = Omit<
  React.ComponentProps<typeof RadixProgress.Root>,
  "className" | "style" | "value" | "asChild"
> & {
  /** Current value in `[0, max]`; `null` renders an indeterminate bar. */
  value: number | null;
  max?: number;
  /** Fill color; `accent` (cyan) by default, `warning` (amber), `danger` (red). */
  tone?: Tone;
  /** External-geometry utilities only (width/basis/flex/responsive); appended last. */
  layoutClassName?: string;
};

export function Progress({
  value,
  max = 100,
  tone = "accent",
  layoutClassName,
  ...rest
}: ProgressProps): React.JSX.Element {
  const isIndeterminate = value == null;
  const clamped = isIndeterminate ? null : Math.max(0, Math.min(max, value));
  const percent = clamped == null ? 0 : (clamped / max) * 100;

  return (
    <RadixProgress.Root
      {...rest}
      value={clamped}
      max={max}
      className={cn(trackClass, layoutClassName)}
    >
      <RadixProgress.Indicator
        className={cn(indicatorBase, indicatorTone[tone])}
        style={isIndeterminate ? undefined : { width: `${percent}%` }}
      />
    </RadixProgress.Root>
  );
}
