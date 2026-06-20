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
      className="relative block h-[96px] min-w-0"
      data-from={from}
      data-to={to}
      aria-hidden={label ? undefined : true}
      role={label ? "presentation" : undefined}
    >
      <svg
        className="block h-full w-full overflow-visible"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        focusable="false"
      >
        <path
          className="fill-none stroke-text-secondary [stroke-width:2.5] [stroke-linecap:round] [vector-effect:non-scaling-stroke]"
          d={path}
        />
      </svg>
      <span
        className="absolute bottom-0 h-0 w-0 -translate-x-1/2 [border-left:7px_solid_transparent] [border-right:7px_solid_transparent] [border-top:9px_solid_var(--text-secondary)]"
        aria-hidden="true"
        style={{ left: ANCHOR_PERCENT[to] }}
      />
      {label ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px]">
          {label}
        </span>
      ) : null}
    </div>
  );
}
