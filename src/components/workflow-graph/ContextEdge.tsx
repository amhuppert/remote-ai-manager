"use client";

import { getBezierPath } from "@xyflow/react";
import type { EdgeProps, Edge } from "@xyflow/react";
import { cn } from "@/lib/ui/cn";
import type { ContextEdgeData } from "./derive-graph";

type ContextEdgeType = Edge<ContextEdgeData>;
type EdgeStatus = "default" | "active" | "completed";

function getEdgeStatus(
  sourceStatus?: string,
  targetStatus?: string,
): EdgeStatus {
  if (!sourceStatus) return "default";

  const sourceCompleted = sourceStatus === "completed";
  const targetCompleted = targetStatus === "completed";
  const targetRunning = targetStatus === "running";
  const targetReady = targetStatus === "ready";

  if (sourceCompleted && targetCompleted) return "completed";
  if (sourceCompleted && (targetRunning || targetReady)) return "active";
  if ((sourceStatus === "running" || sourceCompleted) && targetRunning)
    return "active";

  return "default";
}

// `edge-line` survives as a rule-less hook: the preserved
// `.react-flow__edge.selected .edge-line` rule (workflow-graph.css) recolours the
// path on selection via the React Flow wrapper's `.selected` class.
const EDGE_LINE_BASE =
  "edge-line fill-none stroke-2 transition-[stroke] duration-300";

const EDGE_LINE_STATUS: Record<EdgeStatus, string> = {
  default: "stroke-border-default",
  active:
    "stroke-cyan [stroke-dasharray:8_4] [animation:dash-flow_1s_linear_infinite]",
  completed: "stroke-green-dim",
};

const EDGE_ARROW_STATUS: Record<EdgeStatus, string> = {
  default: "fill-border-default",
  active: "fill-cyan",
  completed: "fill-green-dim",
};

/**
 * A conditional edge (D4 R1) reads as dashed regardless of its lifecycle
 * status, so the guard is visible before the source has ever run. `cn` is plain
 * `clsx` — no tailwind-merge — so the dash is chosen here rather than layered
 * over the status class, which carries a dash of its own for the flowing
 * animation.
 */
const GUARD_DASH = "[stroke-dasharray:3_5]";

/** The verdict tones the chip paints, keyed by the projection's resolution. */
const GUARD_CHIP_TONE: Record<
  NonNullable<ContextEdgeData["guard"]>["resolution"],
  { text: string; fill: string; stroke: string }
> = {
  active: {
    text: "fill-cyan",
    fill: "fill-[var(--cc-cyan-a08)]",
    stroke: "stroke-[var(--cyan-glow-strong)]",
  },
  inactive: {
    text: "fill-text-tertiary",
    fill: "fill-transparent",
    stroke: "stroke-border-default",
  },
  omitted: {
    text: "fill-text-tertiary",
    fill: "fill-transparent",
    stroke: "stroke-border-default",
  },
  unresolved: {
    text: "fill-text-tertiary",
    fill: "fill-transparent",
    stroke: "stroke-border-default",
  },
  unevaluable: {
    text: "fill-red",
    fill: "fill-[var(--cc-red-a08)]",
    stroke: "stroke-[var(--cc-red-a25)]",
  },
};

/**
 * The guard chip, drawn INSIDE the edge's SVG layer rather than through
 * `EdgeLabelRenderer`: the label portal only exists inside a mounted React Flow
 * pane, and the chip must render wherever the edge does.
 */
function GuardChip({
  guard,
  x,
  y,
}: {
  guard: NonNullable<ContextEdgeData["guard"]>;
  x: number;
  y: number;
}) {
  const label = guard.kind === "else" ? "else" : "when";
  const tone = GUARD_CHIP_TONE[guard.resolution];
  const width = label.length * 7 + 12;
  return (
    <g
      role="img"
      data-testid="edge-guard-chip"
      data-resolution={guard.resolution}
      aria-label={`Guarded edge (${label}) — ${guard.resolution}`}
    >
      <rect
        x={x - width / 2}
        y={y - 9}
        width={width}
        height={18}
        rx={9}
        className={cn(tone.fill, tone.stroke)}
      />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        className={cn("font-mono text-[0.62rem]", tone.text)}
      >
        {label}
      </text>
    </g>
  );
}

export default function ContextEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<ContextEdgeType>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const status = getEdgeStatus(data?.sourceStatus, data?.targetStatus);
  const markerId = `arrow-${id}`;
  const guard = data?.guard;
  const effectiveSourceId = data?.effectiveSourceId;

  return (
    <>
      <defs>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="8"
          refY="4"
          orient="auto"
        >
          <path d="M 0 0 L 8 4 L 0 8 Z" className={EDGE_ARROW_STATUS[status]} />
        </marker>
      </defs>
      <path
        id={id}
        d={edgePath}
        {...(guard
          ? {
              "data-guard": guard.kind,
              "data-guard-resolution": guard.resolution,
            }
          : {})}
        className={cn(
          EDGE_LINE_BASE,
          EDGE_LINE_STATUS[status],
          guard && GUARD_DASH,
        )}
        markerEnd={`url(#${markerId})`}
      />
      {guard && <GuardChip guard={guard} x={labelX} y={labelY} />}
      {effectiveSourceId && (
        <text
          data-testid="edge-effective-source"
          x={labelX}
          y={labelY + (guard ? 22 : 4)}
          textAnchor="middle"
          className="fill-text-tertiary font-mono text-[0.6rem]"
        >
          via {effectiveSourceId}
        </text>
      )}
    </>
  );
}
