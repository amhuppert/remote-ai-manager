"use client";

import type { NodeProps } from "./types";

const DEFAULT_WIDTH = 200;
const DEFAULT_HEIGHT_BASE = 56;
const DEFAULT_HEIGHT_WITH_INVOKE = 84;

/**
 * A single state in a machine diagram. Rendered as an absolutely-positioned
 * HTML node so it can use full CSS (gradients, hover, focus rings) while the
 * SVG edge layer underneath stays simple.
 */
export default function StateNode({
  id,
  label,
  kind,
  status,
  x,
  y,
  width,
  height,
  invokes,
  selected,
  related,
  onClick,
}: NodeProps): React.JSX.Element {
  const hasInvokes = (invokes?.length ?? 0) > 0;
  const w = width ?? DEFAULT_WIDTH;
  const h =
    height ?? (hasInvokes ? DEFAULT_HEIGHT_WITH_INVOKE : DEFAULT_HEIGHT_BASE);

  const classes = [
    "mc-node",
    `mc-node--${kind}`,
    status ? `mc-node--${status}` : null,
    selected ? "mc-node--selected" : null,
    related ? "mc-node--related" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      data-state-id={id}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
      }}
      onClick={() => onClick?.(id)}
      aria-pressed={selected}
    >
      <div className="mc-node-row">
        <span className="mc-node-dot" aria-hidden="true" />
        <span className="mc-node-label">{label}</span>
        {kind === "final" && (
          <span className="mc-node-glyph" aria-label="final state">
            ◉
          </span>
        )}
        {kind === "transient" && (
          <span className="mc-node-glyph" aria-label="transient state">
            ⤳
          </span>
        )}
      </div>
      {hasInvokes && (
        <div className="mc-node-invokes">
          {invokes!.map((name) => (
            <span key={name} className="mc-actor-pill">
              <span className="mc-actor-pill-glyph" aria-hidden="true">
                ▸
              </span>
              {name}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
