"use client";

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
  const classes = [
    "mc-event-chip",
    `mc-event-chip--${variant}`,
    active ? "mc-event-chip--active" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
    >
      <span className="mc-event-chip-label">{label}</span>
      {guard && <span className="mc-event-chip-guard">[{guard}]</span>}
    </div>
  );
}
