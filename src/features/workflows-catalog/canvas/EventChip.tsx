"use client";

import { cn } from "@/lib/ui/cn";

interface EventChipProps {
  /** Label center-x in canvas space. */
  x: number;
  /** Label center-y in canvas space. */
  y: number;
  /** Event name, e.g. "SUBMIT_PROMPT" or "onDone". */
  label: string;
  /** Optional guard, displayed below in [brackets]. */
  guard?: string;
  /** Visual emphasis: highlighted when the source/target is selected. */
  active?: boolean;
  /** Render style — "solid" for normal events, "subtle" for onDone/onError. */
  variant?: "solid" | "subtle";
}

/**
 * A label rendered on top of a TransitionEdge at the path midpoint.
 * Uses HTML (not SVG text) so it can leverage the full CSS tokens — mono
 * font, glow accents, hover affordance.
 */
export default function EventChip({
  x,
  y,
  label,
  guard,
  active,
  variant = "solid",
}: EventChipProps): React.JSX.Element {
  const toneClass = active
    ? "border-cyan-dim bg-bg-elevated text-cyan shadow-[0_0_8px_var(--cyan-glow)]"
    : variant === "subtle"
      ? "border-border-subtle bg-bg-surface text-text-tertiary"
      : "border-border-default bg-bg-base text-text-secondary";

  return (
    <div
      className={cn(
        "pointer-events-none absolute z-raised inline-flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-[1px] rounded-sm border border-solid px-[8px] py-[2px] font-mono text-[0.7rem] tracking-[0.02em] whitespace-nowrap",
        toneClass,
      )}
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
    >
      <span className="font-medium">{label}</span>
      {guard && <span className="text-[0.7rem] text-amber">[{guard}]</span>}
    </div>
  );
}
