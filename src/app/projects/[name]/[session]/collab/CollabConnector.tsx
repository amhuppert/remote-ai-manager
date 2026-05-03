"use client";

export type CollabConnectorAnchor = "left" | "right" | "full";

export interface CollabConnectorProps {
  from: CollabConnectorAnchor;
  to: CollabConnectorAnchor;
  label?: string;
}

const VIEW_W = 100;
const VIEW_H = 48;
const ARROW_INSET = 6;

const ANCHOR_X: Record<CollabConnectorAnchor, number> = {
  left: 25,
  right: 75,
  full: 50,
};

const ANCHOR_PERCENT: Record<CollabConnectorAnchor, string> = {
  left: "25%",
  right: "75%",
  full: "50%",
};

function buildPath(
  from: CollabConnectorAnchor,
  to: CollabConnectorAnchor,
): string {
  const x1 = ANCHOR_X[from];
  const x2 = ANCHOR_X[to];
  const y1 = 0;
  const y2 = VIEW_H - ARROW_INSET;
  if (x1 === x2) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }
  const cy = VIEW_H / 2;
  return `M ${x1} ${y1} C ${x1} ${cy}, ${x2} ${cy}, ${x2} ${y2}`;
}

export default function CollabConnector({
  from,
  to,
  label,
}: CollabConnectorProps): React.JSX.Element {
  const path = buildPath(from, to);
  return (
    <div
      className="collab-connector"
      data-from={from}
      data-to={to}
      aria-hidden={label ? undefined : true}
      role={label ? "presentation" : undefined}
    >
      <svg
        className="collab-connector-svg"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        focusable="false"
      >
        <path className="collab-connector-path" d={path} />
      </svg>
      <span
        className="collab-connector-arrow-tip"
        aria-hidden="true"
        style={{ left: ANCHOR_PERCENT[to] }}
      />
      {label ? <span className="collab-connector-label">{label}</span> : null}
    </div>
  );
}
