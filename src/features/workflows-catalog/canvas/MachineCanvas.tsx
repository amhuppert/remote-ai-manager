"use client";

import type React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import EventChip from "./EventChip";
import TransitionEdge, { buildEdgePath } from "./TransitionEdge";
import type { EdgeSpec } from "./types";

/**
 * Outer zoom level applied by the workflow shell. The shell only translates
 * (for pan); zoom is multiplied into the inner auto-fit scale so we render
 * with a single CSS transform — avoiding the blur from stacking two scales.
 */
export const CanvasZoomContext = createContext<number>(1);

interface MachineCanvasProps {
  /** Logical canvas width in pixels. */
  width: number;
  /** Logical canvas height in pixels. */
  height: number;
  /** Edges drawn underneath the node layer. */
  edges: EdgeSpec[];
  /** Currently-selected state id (drives edge highlighting). */
  selectedStateId?: string | null;
  /** State node React tree positioned absolutely over the edge layer. */
  children?: React.ReactNode;
}

/**
 * Container for one workflow visualization. Sets up:
 *  - A fixed-pixel canvas auto-scaled to fit the available viewport width
 *  - An SVG layer for edges + arrowhead `<defs>`
 *  - A label layer for HTML-based EventChips at edge midpoints
 *  - A node layer fed by `children` (StateNode / CompoundGroup)
 *
 * Scaling is uniform (never upscales beyond 1:1) so layouts that already fit
 * are pixel-perfect, while wider canvases shrink to the available column.
 */
export default function MachineCanvas({
  width,
  height,
  edges,
  selectedStateId,
  children,
}: MachineCanvasProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const outerZoom = useContext(CanvasZoomContext);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;

    // Use offsetWidth/Height (layout dimensions, unaffected by CSS transforms on
    // ancestors) so the outer pan/zoom shell can grow the surface without
    // retriggering the inner auto-fit recursively. Multiply by outerZoom so
    // user-initiated zoom is folded into this single transform — stacking two
    // CSS scales (here + on the shell) would double-rasterize and blur.
    function recompute(): void {
      if (!node) return;
      const availableWidth = Math.max(0, node.offsetWidth - 16);
      const availableHeight = Math.max(0, node.offsetHeight - 16);
      if (availableWidth === 0 || availableHeight === 0) return;
      const widthScale = availableWidth / width;
      const heightScale = availableHeight / height;
      const fit = Math.min(1, widthScale, heightScale);
      const next = fit * outerZoom;
      setScale(Number.isFinite(next) && next > 0 ? next : 1);
    }

    const observer = new ResizeObserver(() => recompute());
    observer.observe(node);
    window.addEventListener("resize", recompute);
    recompute();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [width, height, outerZoom]);

  return (
    <div className="mc-viewport" ref={viewportRef}>
      <div
        className="mc-canvas-frame"
        style={{
          width: `${width * scale}px`,
          height: `${height * scale}px`,
        }}
      >
        <div
          className="mc-canvas"
          style={{
            width: `${width}px`,
            height: `${height}px`,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <svg
            className="mc-edge-layer"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="mc-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)" />
              </marker>
              <marker
                id="mc-arrow-selected"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--cyan)" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const isSelected =
                selectedStateId != null &&
                (edge.fromStateId === selectedStateId ||
                  edge.toStateId === selectedStateId);
              return (
                <TransitionEdge
                  key={edge.id}
                  spec={edge}
                  selected={isSelected}
                />
              );
            })}
          </svg>
          <div className="mc-label-layer" aria-hidden="false">
            {edges.map((edge) => {
              if (!edge.label) return null;
              const { mid } = buildEdgePath(edge);
              const offset = edge.labelOffset ?? { x: 0, y: 0 };
              const isActive =
                selectedStateId != null &&
                (edge.fromStateId === selectedStateId ||
                  edge.toStateId === selectedStateId);
              return (
                <EventChip
                  key={`${edge.id}-label`}
                  x={mid.x + offset.x}
                  y={mid.y + offset.y}
                  label={edge.label}
                  guard={edge.guard}
                  active={isActive}
                  variant={edge.dashed ? "subtle" : "solid"}
                />
              );
            })}
          </div>
          <div className="mc-node-layer">{children}</div>
        </div>
      </div>
    </div>
  );
}
