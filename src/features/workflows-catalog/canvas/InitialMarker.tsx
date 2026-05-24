"use client";

interface InitialMarkerProps {
  /** Center x of the dot in canvas space. */
  x: number;
  /** Center y of the dot in canvas space. */
  y: number;
}

/**
 * A small filled cyan dot — the XState convention for marking the initial
 * state of a machine or compound state. Pair with a TransitionEdge from this
 * point into the initial state node.
 */
export default function InitialMarker({
  x,
  y,
}: InitialMarkerProps): React.JSX.Element {
  return (
    <div
      className="mc-initial-marker"
      style={{ left: `${x - 7}px`, top: `${y - 7}px` }}
      aria-hidden="true"
    />
  );
}
