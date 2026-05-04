"use client";

import type React from "react";

interface CompoundGroupProps {
  /** Top-left in canvas space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Display label (rendered uppercase in mono). */
  label: string;
  /** Optional sub-label rendered after the main one, e.g. "compound". */
  hint?: string;
  /** Status hint that changes the border color. */
  status?: "neutral" | "warning" | "success" | "failure";
  /** Becomes true when the compound state is selected. */
  selected?: boolean;
  /** Click handler — fired when the compound's chrome (not its children) is clicked. */
  stateId?: string;
  onClickHeader?: (stateId: string) => void;
  children?: React.ReactNode;
}

/**
 * A dashed wrapper around a compound state's children. Children are rendered
 * inside the same absolute-positioning context (positions are still in canvas
 * coordinates, not relative to the group).
 */
export default function CompoundGroup({
  x,
  y,
  width,
  height,
  label,
  hint,
  status,
  selected,
  stateId,
  onClickHeader,
  children,
}: CompoundGroupProps): React.JSX.Element {
  const classes = [
    "mc-group",
    status ? `mc-group--${status}` : null,
    selected ? "mc-group--selected" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <div
        className={classes}
        style={{
          left: `${x}px`,
          top: `${y}px`,
          width: `${width}px`,
          height: `${height}px`,
        }}
        aria-hidden="true"
      >
        <button
          type="button"
          className="mc-group-header"
          onClick={() => stateId && onClickHeader?.(stateId)}
          disabled={!stateId || !onClickHeader}
          tabIndex={stateId ? 0 : -1}
        >
          <span className="mc-group-label">{label}</span>
          {hint && <span className="mc-group-hint">{hint}</span>}
        </button>
      </div>
      {children}
    </>
  );
}
