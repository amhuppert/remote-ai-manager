"use client";

import { cn } from "@/lib/ui/cn";
import type { EdgeSpec, Point } from "./types";

/**
 * Returns the SVG `d` attribute for an edge plus its midpoint (used to place
 * the EventChip). All routing math lives here so layouts can stay declarative.
 */
export function buildEdgePath(spec: EdgeSpec): { d: string; mid: Point } {
  const {
    from,
    to,
    routing = "curve",
    bow,
    control,
    loopSide = "right",
  } = spec;

  if (routing === "straight") {
    return {
      d: `M ${from.x} ${from.y} L ${to.x} ${to.y}`,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
    };
  }

  if (routing === "step") {
    return stepPath(from, to, bow);
  }

  if (routing === "loop") {
    return loopPath(from, to, loopSide);
  }

  return curvePath(from, to, bow, control);
}

function curvePath(
  from: Point,
  to: Point,
  bow: "h" | "v" | undefined,
  control: Point | undefined,
): { d: string; mid: Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const horizontalFlow =
    bow === "v" || (bow !== "h" && Math.abs(dx) >= Math.abs(dy));

  let c1: Point;
  let c2: Point;
  if (control) {
    c1 = control;
    c2 = control;
  } else if (horizontalFlow) {
    const midX = from.x + dx * 0.5;
    c1 = { x: midX, y: from.y };
    c2 = { x: midX, y: to.y };
  } else {
    const midY = from.y + dy * 0.5;
    c1 = { x: from.x, y: midY };
    c2 = { x: to.x, y: midY };
  }

  const d = `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
  return { d, mid: bezierMidpoint(from, c1, c2, to) };
}

function stepPath(
  from: Point,
  to: Point,
  bow: "h" | "v" | undefined,
): { d: string; mid: Point } {
  // L-shape: go all-the-way along one axis, then the other. `bow === "v"`
  // means "bow vertically" → go vertical first, then horizontal.
  if (bow === "v") {
    return {
      d: `M ${from.x} ${from.y} L ${from.x} ${to.y} L ${to.x} ${to.y}`,
      mid: { x: from.x, y: to.y },
    };
  }
  return {
    d: `M ${from.x} ${from.y} L ${to.x} ${from.y} L ${to.x} ${to.y}`,
    mid: { x: to.x, y: from.y },
  };
}

function loopPath(
  from: Point,
  to: Point,
  side: "left" | "right" | "top" | "bottom",
): { d: string; mid: Point } {
  // A loop goes out from the source anchor, swings around, and comes back to
  // the target anchor. Used for self-loops where source and target are on the
  // same node.
  const offset = 50;
  let c1: Point;
  let c2: Point;
  let mid: Point;

  if (side === "right") {
    c1 = { x: from.x + offset, y: from.y };
    c2 = { x: to.x + offset, y: to.y };
    mid = { x: from.x + offset * 0.85, y: (from.y + to.y) / 2 };
  } else if (side === "left") {
    c1 = { x: from.x - offset, y: from.y };
    c2 = { x: to.x - offset, y: to.y };
    mid = { x: from.x - offset * 0.85, y: (from.y + to.y) / 2 };
  } else if (side === "top") {
    c1 = { x: from.x, y: from.y - offset };
    c2 = { x: to.x, y: to.y - offset };
    mid = { x: (from.x + to.x) / 2, y: from.y - offset * 0.85 };
  } else {
    c1 = { x: from.x, y: from.y + offset };
    c2 = { x: to.x, y: to.y + offset };
    mid = { x: (from.x + to.x) / 2, y: from.y + offset * 0.85 };
  }

  return {
    d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
    mid,
  };
}

function bezierMidpoint(p0: Point, p1: Point, p2: Point, p3: Point): Point {
  // De Casteljau's algorithm at t=0.5 for a cubic bezier.
  const t = 0.5;
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x,
    y:
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y,
  };
}

interface TransitionEdgeProps {
  spec: EdgeSpec;
  selected?: boolean;
}

/**
 * Renders an SVG `<path>` for a single edge. Must be a child of an `<svg>`.
 * The MachineCanvas sets up the parent SVG plus the arrowhead marker `<defs>`.
 */
export default function TransitionEdge({
  spec,
  selected,
}: TransitionEdgeProps): React.JSX.Element {
  const { d } = buildEdgePath(spec);
  const classes = cn(
    "fill-none transition-[stroke,stroke-width] duration-150 ease-[ease]",
    selected
      ? "stroke-cyan [stroke-width:2] [filter:drop-shadow(0_0_4px_var(--cyan-glow-strong))]"
      : "stroke-text-tertiary [stroke-width:1.4]",
    spec.dashed && "[stroke-dasharray:4_3]",
  );
  return (
    <path
      className={classes}
      d={d}
      markerEnd={selected ? "url(#mc-arrow-selected)" : "url(#mc-arrow)"}
      data-from={spec.fromStateId ?? ""}
      data-to={spec.toStateId ?? ""}
    />
  );
}
